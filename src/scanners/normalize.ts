/**
 * Normalization helpers + tuned constants shared by all deterministic scanners.
 *
 * Every scanner emits a score in [0, 1] where 1 = best, so the uplift math in
 * stats/aggregate.ts stays uniform across dimensions. Ceilings below are the
 * point at which a density maps to score 0; they are deliberately explicit and
 * documented (not magic numbers) so the report can disclose them and Opus can
 * recalibrate against real-world repos. See docs/architecture.md invariant 9.
 */

/** Lint errors-per-KLOC that maps to score 0. Warnings count at LINT_WARNING_WEIGHT. */
export const LINT_CEILING_PER_KLOC = 15;
export const LINT_WARNING_WEIGHT = 0.25;

/** Weighted security findings-per-KLOC that maps to score 0. */
export const SECURITY_CEILING_PER_KLOC = 8;

/** Cyclomatic complexity at/above which a function is "unhealthy".
 *  15 is a common industry threshold (SonarQube default is 15 for functions). */
export const COMPLEXITY_UNHEALTHY = 15;

/** Severity weights for security findings (before CWE-class multiplier). */
export const SEVERITY_WEIGHT: Record<string, number> = {
  error: 1,
  high: 1,
  warning: 0.5,
  medium: 0.5,
  info: 0.2,
  low: 0.2,
};

/**
 * CWE-class multipliers. Sanitization bugs (XSS, log injection) are the classes
 * where zero-shot LLM code fails most (Veracode: XSS ~13% pass, log-injection
 * ~12% pass), so they are the most diagnostic — weight them up. Classes LLMs
 * handle well (crypto, SQLi) are weighted down. See research-report.md §2.4.
 */
export const CWE_CLASS_WEIGHT: { pattern: RegExp; weight: number; label: string }[] = [
  { pattern: /(xss|cross.?site|CWE-79|CWE-80)/i, weight: 1.5, label: 'xss' },
  { pattern: /(log.?injection|CWE-117)/i, weight: 1.5, label: 'log-injection' },
  { pattern: /(path.?traversal|CWE-22|ssrf|CWE-918)/i, weight: 1.3, label: 'path/ssrf' },
  { pattern: /(inject|CWE-89|CWE-78|command)/i, weight: 1.2, label: 'injection' },
  { pattern: /(crypto|CWE-327|CWE-328)/i, weight: 0.7, label: 'crypto' },
];

export function cweWeight(text: string): number {
  for (const { pattern, weight } of CWE_CLASS_WEIGHT) {
    if (pattern.test(text)) return weight;
  }
  return 1;
}

/** Map a density (per KLOC) to a [0,1] score via a linear ceiling. 0 density → 1. */
export function densityToScore(count: number, loc: number, ceilingPerKloc: number): number {
  if (loc <= 0) return 1;
  const perKloc = (count / loc) * 1000;
  return clamp01(1 - perKloc / ceilingPerKloc);
}

export function clamp01(x: number): number {
  if (Number.isNaN(x)) return 0;
  return Math.max(0, Math.min(1, x));
}
