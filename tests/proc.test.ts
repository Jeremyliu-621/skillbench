import { describe, expect, it } from 'vitest';
import { commandExists, runProcess, CommandNotFoundError } from '../src/engine/proc.js';

describe('runProcess', () => {
  it('captures stdout and a zero exit code', async () => {
    const r = await runProcess('node', ['-e', 'process.stdout.write("hi")']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('hi');
    expect(r.timedOut).toBe(false);
  });

  it('passes stdin and closes it (no hang)', async () => {
    const r = await runProcess('node', ['-e', 'process.stdin.pipe(process.stdout)'], { stdin: 'echoed' });
    expect(r.stdout).toBe('echoed');
  });

  it('reports non-zero exit codes', async () => {
    const r = await runProcess('node', ['-e', 'process.exit(3)']);
    expect(r.exitCode).toBe(3);
  });

  it('flags timeouts instead of hanging', async () => {
    const r = await runProcess('node', ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
  });

  it('signals a missing command (throws on POSIX, non-zero exit under the win32 shell)', async () => {
    // Cross-platform contract: `commandExists` is the reliable detector callers
    // use; a raw run of a missing binary either rejects with CommandNotFoundError
    // (direct spawn) or resolves non-zero (cmd.exe "not recognized").
    try {
      const r = await runProcess('definitely-not-a-real-binary-xyz', []);
      expect(r.exitCode).not.toBe(0);
    } catch (err) {
      expect(err).toBeInstanceOf(CommandNotFoundError);
    }
  });
});

describe('runProcess with a full executable path', () => {
  it('handles spaces in the command path (e.g. C:\\Program Files\\...\\node.exe)', async () => {
    // Regression: shell mode quoted args but not the command, so process.execPath
    // broke at the first space on Windows.
    const r = await runProcess(process.execPath, ['-e', 'process.stdout.write("direct")']);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toBe('direct');
  });
});

describe('commandExists', () => {
  it('returns a version line for a present command', async () => {
    const v = await commandExists('node');
    expect(v).toMatch(/^v?\d+\./);
  });

  it('returns null for an absent command', async () => {
    expect(await commandExists('definitely-not-a-real-binary-xyz')).toBeNull();
  });
});
