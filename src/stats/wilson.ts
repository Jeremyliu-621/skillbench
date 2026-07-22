import type { ConfidenceInterval } from '../types.js';

/**
 * Wilson score interval for a binomial proportion.
 *
 * Used for head-to-head win rates instead of the naive CLT interval (mean ± 1.96·SE),
 * which under-covers badly at our sample sizes (10–50 modules) and can produce
 * intervals outside [0,1] — see docs/research-report.md §2.5.
 *
 * `successes` may be fractional because ties count as ½ a win; this is a standard,
 * documented approximation (the interval is computed on the effective proportion).
 */
export function wilson(successes: number, trials: number, confidence = 0.95): ConfidenceInterval {
  if (trials <= 0) {
    return { estimate: 0, lo: 0, hi: 1, method: 'wilson' };
  }
  if (successes < 0 || successes > trials) {
    throw new Error(`successes (${successes}) must be within [0, trials=${trials}]`);
  }
  const z = zForConfidence(confidence);
  const n = trials;
  const p = successes / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    estimate: p,
    lo: Math.max(0, center - half),
    hi: Math.min(1, center + half),
    method: 'wilson',
  };
}

/** Two-sided z for common confidence levels (avoids pulling in a stats dependency). */
export function zForConfidence(confidence: number): number {
  const table: Record<string, number> = {
    '0.9': 1.6449,
    '0.95': 1.96,
    '0.99': 2.5758,
  };
  const z = table[String(confidence)];
  if (z === undefined) {
    throw new Error(`Unsupported confidence level ${confidence}; use 0.9, 0.95, or 0.99`);
  }
  return z;
}
