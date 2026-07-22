import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../engine/proc.js';
import { clamp01 } from './normalize.js';

/** Duplication via jscpd (npm). Score = 1 − duplicated-line fraction. */

export interface DuplicationResult {
  score: number;
  clonePercent: number;
}

/** Pure: extract duplicated-line fraction from a jscpd JSON report. */
export function parseJscpd(report: unknown): DuplicationResult {
  const pct =
    (report as { statistics?: { total?: { percentage?: number } } })?.statistics?.total?.percentage ?? 0;
  return { score: clamp01(1 - pct / 100), clonePercent: pct };
}

export async function runDuplication(targetDir: string): Promise<DuplicationResult | null> {
  const outDir = await mkdtemp(join(tmpdir(), '2bench-jscpd-'));
  try {
    const { exitCode, timedOut } = await runProcess(
      'npx',
      ['--no-install', 'jscpd', '--silent', '--reporters', 'json', '--output', outDir, targetDir],
      { timeoutMs: 120_000 },
    );
    if (timedOut) return null;
    // jscpd exits non-zero when a --threshold is exceeded; we set none, but be lenient.
    const raw = await readFile(join(outDir, 'jscpd-report.json'), 'utf8').catch(() => null);
    if (raw === null) return exitCode === 0 ? { score: 1, clonePercent: 0 } : null;
    return parseJscpd(JSON.parse(raw));
  } catch {
    return null;
  } finally {
    await rm(outDir, { recursive: true, force: true }).catch(() => {});
  }
}
