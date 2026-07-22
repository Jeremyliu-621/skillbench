import { runProcess } from '../engine/proc.js';
import {
  SECURITY_CEILING_PER_KLOC,
  SEVERITY_WEIGHT,
  clamp01,
  cweWeight,
  densityToScore,
} from './normalize.js';

/**
 * Security via Semgrep. Each finding is weighted by severity × CWE-class multiplier
 * (sanitization classes like XSS/log-injection weigh most — the classes zero-shot
 * LLMs fail hardest per Veracode). Score = 1 − weighted-density mapped through a
 * per-KLOC ceiling.
 */

export interface SecurityResult {
  score: number;
  findingCount: number;
  weightedFindings: number;
  byClass: Record<string, number>;
}

interface SemgrepFinding {
  check_id?: string;
  extra?: { severity?: string; metadata?: { cwe?: string | string[] } };
}

/** Pure: weight and score a Semgrep JSON result given the target's LOC. */
export function parseSemgrep(report: unknown, loc: number): SecurityResult {
  const results = (report as { results?: SemgrepFinding[] })?.results ?? [];
  let weighted = 0;
  const byClass: Record<string, number> = {};
  for (const f of results) {
    const severity = (f.extra?.severity ?? 'warning').toLowerCase();
    const cweText = [f.check_id ?? '', ...toArray(f.extra?.metadata?.cwe)].join(' ');
    const w = (SEVERITY_WEIGHT[severity] ?? 0.5) * cweWeight(cweText);
    weighted += w;
    const key = classify(cweText);
    byClass[key] = (byClass[key] ?? 0) + 1;
  }
  return {
    score: densityToScore(weighted, loc, SECURITY_CEILING_PER_KLOC),
    findingCount: results.length,
    weightedFindings: weighted,
    byClass,
  };
}

/** Fold hardcoded-secret findings into the security score (a secret is severe). */
export function applySecretPenalty(security: SecurityResult, secretCount: number, loc: number): SecurityResult {
  if (secretCount <= 0) return security;
  const weighted = security.weightedFindings + secretCount * 2; // secrets weigh 2 each
  return {
    ...security,
    weightedFindings: weighted,
    score: clamp01(densityToScore(weighted, loc, SECURITY_CEILING_PER_KLOC)),
    byClass: { ...security.byClass, secret: secretCount },
  };
}

export async function runSecurity(targetDir: string, loc: number): Promise<SecurityResult | null> {
  try {
    const { stdout, timedOut } = await runProcess(
      'semgrep',
      ['--config', 'auto', '--json', '--quiet', '--no-git-ignore', targetDir],
      { timeoutMs: 180_000 },
    );
    if (timedOut || !stdout.trim()) return null;
    return parseSemgrep(JSON.parse(stdout), loc);
  } catch {
    return null;
  }
}

function toArray(v: string | string[] | undefined): string[] {
  if (v === undefined) return [];
  return Array.isArray(v) ? v : [v];
}

function classify(text: string): string {
  if (/(xss|cross.?site|CWE-79|CWE-80)/i.test(text)) return 'xss';
  if (/(log.?injection|CWE-117)/i.test(text)) return 'log-injection';
  if (/(inject|CWE-89|CWE-78)/i.test(text)) return 'injection';
  if (/(crypto|CWE-327)/i.test(text)) return 'crypto';
  return 'other';
}
