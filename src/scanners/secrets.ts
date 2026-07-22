import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runProcess } from '../engine/proc.js';

/**
 * Hardcoded-secret detection via gitleaks. Reported as a raw count (any > 0 is
 * surfaced loudly in the report — embedded credentials are exactly the failure
 * a SonarCloud gate is typically added to catch). Also folded into the security
 * score (see security.applySecretPenalty).
 */

export interface SecretsResult {
  count: number;
}

/** Pure: count findings in a gitleaks JSON report (an array of findings). */
export function parseGitleaks(report: unknown): SecretsResult {
  return { count: Array.isArray(report) ? report.length : 0 };
}

export async function runSecrets(targetDir: string): Promise<SecretsResult | null> {
  const outFile = join(await mkdtemp(join(tmpdir(), '2bench-gitleaks-')), 'report.json');
  try {
    // gitleaks exits 1 when leaks are found — that is a normal result, not an error.
    const { timedOut } = await runProcess(
      'gitleaks',
      ['detect', '--no-git', '--report-format', 'json', '--report-path', outFile, '-s', targetDir],
      { timeoutMs: 120_000 },
    );
    if (timedOut) return null;
    const raw = await readFile(outFile, 'utf8').catch(() => null);
    if (raw === null) return { count: 0 }; // no report written = no leaks
    return parseGitleaks(JSON.parse(raw));
  } catch {
    return null;
  } finally {
    await rm(join(outFile, '..'), { recursive: true, force: true }).catch(() => {});
  }
}
