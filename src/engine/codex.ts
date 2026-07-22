import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { commandExists, runProcess } from './proc.js';

/**
 * Headless driver for the OpenAI Codex CLI (`codex exec`) — the zero-marginal-cost
 * generation + judging engine (user runs on a flat subscription).
 *
 * Invocation pattern verified locally on codex-cli 0.144.5 (2026-07-17):
 *  - MUST close/own stdin: `codex exec` blocks forever waiting for EOF on piped
 *    stdin in non-TTY contexts. We pass the prompt VIA stdin (`codex exec -`) and
 *    end the stream — this both avoids the hang and sidesteps argv quoting limits.
 *  - `--json` emits a JSONL event stream on stdout (incl. token usage on
 *    turn.completed events); the final message is captured via `-o <file>`.
 *  - `--output-schema <file>` forces the final message to conform to a JSON Schema
 *    (used for judge verdicts).
 *  - Default reasoning effort is NONE — judging must raise it (research:
 *    non-reasoning judges are near-random on code). We pass
 *    `-c model_reasoning_effort=<effort>`.
 *  - Subscription auth shares a 5-hour rolling usage window with interactive use;
 *    long batch runs should checkpoint and be resumable (see pipeline TODOs).
 */

export interface CodexOptions {
  /** Working root the agent operates in (`-C`). */
  cwd: string;
  /** Default read-only; regeneration needs workspace-write. */
  sandbox?: 'read-only' | 'workspace-write';
  model?: string;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** JSON Schema object for structured final output. */
  outputSchema?: object;
  timeoutMs?: number;
}

export interface CodexEvent {
  type: string;
  [key: string]: unknown;
}

export interface CodexResult {
  finalMessage: string;
  events: CodexEvent[];
  tokens: { input: number; cachedInput: number; output: number };
  durationMs: number;
}

export class CodexError extends Error {
  constructor(
    message: string,
    readonly exitCode: number | null,
    readonly stderrTail: string,
  ) {
    super(message);
    this.name = 'CodexError';
  }
}

export async function codexExec(prompt: string, opts: CodexOptions): Promise<CodexResult> {
  const started = Date.now();
  const workDir = await mkdtemp(join(tmpdir(), '2bench-codex-'));
  const outFile = join(workDir, 'last-message.txt');

  const args = [
    'exec',
    '--skip-git-repo-check',
    '--ephemeral',
    '--json',
    '-s',
    opts.sandbox ?? 'read-only',
    '-C',
    opts.cwd,
    '-o',
    outFile,
  ];
  if (opts.model) args.push('-m', opts.model);
  if (opts.reasoningEffort) args.push('-c', `model_reasoning_effort=${opts.reasoningEffort}`);
  if (opts.outputSchema) {
    const schemaFile = join(workDir, 'output-schema.json');
    await writeFile(schemaFile, JSON.stringify(opts.outputSchema), 'utf8');
    args.push('--output-schema', schemaFile);
  }
  args.push('-'); // read the prompt from stdin

  try {
    const { stdout, stderr, exitCode, timedOut } = await runProcess('codex', args, {
      stdin: prompt,
      timeoutMs: opts.timeoutMs ?? 600_000,
    });

    if (timedOut) {
      throw new CodexError(`codex timed out after ${opts.timeoutMs ?? 600_000}ms`, null, stderr.slice(-2000));
    }
    if (exitCode !== 0) {
      throw new CodexError(
        `codex exec failed with exit code ${exitCode}`,
        exitCode,
        stderr.slice(-2000),
      );
    }

    const events = parseJsonl(stdout);
    const finalMessage = await readFile(outFile, 'utf8').catch(() => extractLastMessage(events));
    return {
      finalMessage: finalMessage.trim(),
      events,
      tokens: sumTokens(events),
      durationMs: Date.now() - started,
    };
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/** Convenience: run a judging/extraction prompt and parse the schema-constrained reply. */
export async function codexExecJson<T>(prompt: string, schema: object, opts: Omit<CodexOptions, 'outputSchema'>): Promise<{ value: T; result: CodexResult }> {
  const result = await codexExec(prompt, { ...opts, outputSchema: schema });
  try {
    return { value: JSON.parse(result.finalMessage) as T, result };
  } catch {
    throw new CodexError(
      `codex returned non-JSON despite --output-schema: ${result.finalMessage.slice(0, 200)}`,
      0,
      '',
    );
  }
}

export async function codexVersion(): Promise<string | null> {
  return commandExists('codex');
}

function parseJsonl(stdout: string): CodexEvent[] {
  const events: CodexEvent[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed.type === 'string') events.push(parsed);
    } catch {
      // non-JSON noise on stdout is expected in some codex versions; ignore
    }
  }
  return events;
}

function sumTokens(events: CodexEvent[]): CodexResult['tokens'] {
  const tokens = { input: 0, cachedInput: 0, output: 0 };
  for (const e of events) {
    const usage = (e as { usage?: Record<string, number> }).usage;
    if (!usage) continue;
    tokens.input += usage.input_tokens ?? 0;
    tokens.cachedInput += usage.cached_input_tokens ?? 0;
    tokens.output += usage.output_tokens ?? 0;
  }
  return tokens;
}

function extractLastMessage(events: CodexEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as { type: string; message?: string; text?: string } | undefined;
    if (!e) continue;
    if (typeof e.message === 'string') return e.message;
    if (typeof e.text === 'string') return e.text;
  }
  return '';
}
