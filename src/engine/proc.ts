import { spawn, type ChildProcess } from 'node:child_process';

/**
 * One cross-platform child-process runner, shared by the Codex engine and every
 * external scanner (semgrep, gitleaks, jscpd, eslint, stryker).
 *
 * Windows note: npm installs CLIs as `.cmd`/`.ps1` shims, and Node refuses to
 * spawn `.cmd` without a shell (CVE-2024-27980 hardening). So on win32 we run
 * through the shell with self-quoted args. Inputs never travel through argv when
 * they might contain untrusted content — pass them via `stdin` instead.
 */

export interface RunOptions {
  cwd?: string;
  /** Written to the child's stdin, which is then closed (some CLIs block on open stdin). */
  stdin?: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Cap retained stdout/stderr to guard against huge scanner output (default 32 MiB). */
  maxBuffer?: number;
}

export interface ProcResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
}

export class CommandNotFoundError extends Error {
  constructor(readonly command: string) {
    super(`Command not found: ${command}`);
    this.name = 'CommandNotFoundError';
  }
}

export function runProcess(command: string, args: string[], opts: RunOptions = {}): Promise<ProcResult> {
  const timeoutMs = opts.timeoutMs ?? 600_000;
  const maxBuffer = opts.maxBuffer ?? 32 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    // Windows: bare names (codex, npx) may resolve to .cmd shims, which Node
    // refuses to spawn without a shell — but a direct path to an .exe (e.g.
    // process.execPath) needs no shell and must NOT take the quoting detour.
    const needsShell = process.platform === 'win32' && !command.toLowerCase().endsWith('.exe');
    const child = needsShell
      ? spawn([quoteForCmd(command), ...args.map(quoteForCmd)].join(' '), {
          shell: true,
          windowsHide: true,
          cwd: opts.cwd,
          env: opts.env,
        })
      : spawn(command, args, { windowsHide: true, cwd: opts.cwd, env: opts.env });

    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      // Kill the whole tree: with shell:true (win32) the ChildProcess is the
      // shell, and the real work runs in a grandchild that a plain kill orphans.
      // Resolve immediately rather than await 'close', which may never fire while
      // an orphaned grandchild still holds the inherited stdio pipes open.
      killTree(child);
      resolve({ stdout, stderr, exitCode: null, timedOut: true });
    }, timeoutMs);

    child.stdout?.on('data', (d: Buffer) => {
      stdoutBytes += d.length;
      if (stdoutBytes <= maxBuffer) stdout += d.toString('utf8');
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrBytes += d.length;
      if (stderrBytes <= maxBuffer) stderr += d.toString('utf8');
    });

    child.on('error', (err: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err.code === 'ENOENT' ? new CommandNotFoundError(command) : err);
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut: false });
    });

    if (opts.stdin !== undefined) {
      child.stdin?.write(opts.stdin);
    }
    child.stdin?.end(); // critical: several CLIs (incl. codex) block until stdin EOF
  });
}

/** Whether a CLI is on PATH, via `<cmd> --version`. Never throws. */
export async function commandExists(command: string, versionArg = '--version'): Promise<string | null> {
  try {
    const { stdout, stderr, exitCode } = await runProcess(command, [versionArg], { timeoutMs: 30_000 });
    if (exitCode !== 0) return null;
    return (stdout || stderr).trim().split('\n')[0] ?? '';
  } catch {
    return null;
  }
}

function quoteForCmd(arg: string): string {
  if (arg.length > 0 && !/[\s"&|<>^%()]/.test(arg)) return arg;
  return `"${arg.replace(/"/g, '""')}"`;
}

/** Best-effort tree kill. On Windows uses taskkill /T to reap grandchildren
 *  spawned under the shell; elsewhere a direct SIGKILL suffices. */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    try {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
    } catch {
      child.kill('SIGKILL');
    }
  } else {
    child.kill('SIGKILL');
  }
}
