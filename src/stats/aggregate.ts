import type {
  BenchConfig,
  ConfidenceInterval,
  Dimension,
  DimensionResult,
  DimensionScores,
  PairOutcome,
} from '../types.js';
import { DIMENSIONS } from '../types.js';
import { wilson } from './wilson.js';
import { bootstrapCI, mean } from './bootstrap.js';

/**
 * Aggregation layer: turns raw pairwise outcomes and per-side dimension scores
 * into the two headline numbers (win rate, weighted relative uplift) and the gate.
 * All math here is pure and seeded — no LLM involvement past this point.
 */

/** Head-to-head win rate with ties counted as ½ (ties are ~20% of pairwise
 *  outcomes in large human-preference data and must not be dropped). */
export function winRate(outcomes: readonly PairOutcome[], confidence = 0.95): ConfidenceInterval {
  const n = outcomes.length;
  const wins = outcomes.filter((o) => o.winner === 'repo').length;
  const ties = outcomes.filter((o) => o.winner === 'tie').length;
  return wilson(wins + ties / 2, n, confidence);
}

/** Relative uplift on one dimension: (repo − baseline) / baseline.
 *  Baseline scores are clamped away from zero so a catastrophically bad baseline
 *  yields a large-but-finite uplift instead of Infinity; the clamp is reported. */
export const BASELINE_FLOOR = 0.05;

export function relativeUplift(repoScore: number, baselineScore: number): number {
  const floored = Math.max(baselineScore, BASELINE_FLOOR);
  return (repoScore - floored) / floored;
}

export function compositeUplift(dimensions: readonly DimensionResult[]): number {
  const measured = dimensions.filter((d) => d.inUplift);
  const wsum = measured.reduce((s, d) => s + d.weight, 0);
  if (wsum === 0) return 0;
  return measured.reduce((sum, d) => sum + (d.weight / wsum) * d.uplift, 0);
}

/**
 * Aggregate per-module dimension scores into the dimension-level breakdown and
 * the per-module composite uplifts used for the bootstrap CI.
 *
 * Per dimension: average repo/baseline scores over the modules that measured it
 * on both sides, and take the relative uplift of those means. A dimension with
 * zero measured modules is reported (for transparency) but excluded from uplift.
 *
 * Per module: weighted uplift over that module's measured dimensions, weights
 * renormalized to the available set — the paired quantity we bootstrap over
 * (research-report.md §2.5: paired per-module differences). Returned ALIGNED
 * with the input (null where a module measured nothing) so callers can zip in
 * cluster labels before filtering.
 */
export function aggregateDimensions(
  perModule: ReadonlyArray<{ repo: DimensionScores; baseline: DimensionScores }>,
  weights: BenchConfig['weights'],
): { dimensions: DimensionResult[]; perModuleCompositeUplift: (number | null)[] } {
  const dimensions: DimensionResult[] = DIMENSIONS.map((dimension) => {
    const pairs = perModule
      .map((m) => ({ r: m.repo[dimension], b: m.baseline[dimension] }))
      .filter((p): p is { r: number; b: number } => p.r !== null && p.b !== null);
    const repoScore = pairs.length ? mean(pairs.map((p) => p.r)) : null;
    const baselineScore = pairs.length ? mean(pairs.map((p) => p.b)) : null;
    return {
      dimension,
      repoScore,
      baselineScore,
      uplift: repoScore !== null && baselineScore !== null ? relativeUplift(repoScore, baselineScore) : 0,
      weight: weights[dimension],
      modulesMeasured: pairs.length,
      inUplift: pairs.length > 0,
    };
  });

  const perModuleCompositeUplift = perModule.map((m) => moduleCompositeUplift(m, weights));

  return { dimensions, perModuleCompositeUplift };
}

function moduleCompositeUplift(
  m: { repo: DimensionScores; baseline: DimensionScores },
  weights: BenchConfig['weights'],
): number | null {
  const contributions: { weight: number; uplift: number }[] = [];
  for (const dimension of DIMENSIONS) {
    const r = m.repo[dimension];
    const b = m.baseline[dimension];
    if (r !== null && b !== null) {
      contributions.push({ weight: weights[dimension], uplift: relativeUplift(r, b) });
    }
  }
  const wsum = contributions.reduce((s, c) => s + c.weight, 0);
  if (wsum === 0) return null; // module measured nothing → excluded from the CI
  return contributions.reduce((s, c) => s + (c.weight / wsum) * c.uplift, 0);
}

/**
 * Headline uplift CI: bootstrap over per-module composite uplifts (paired design —
 * each value is repo-vs-baseline on the SAME module, which is what makes the
 * variance small enough to be useful at N=10–30).
 */
export function upliftCI(
  perModuleCompositeUplift: readonly number[],
  opts: { iterations: number; confidence: number; seed: number },
): ConfidenceInterval {
  return bootstrapCI(perModuleCompositeUplift, {
    iterations: opts.iterations,
    confidence: opts.confidence,
    seed: opts.seed,
    statistic: mean,
  });
}

/** The 40%-rule gate: pass iff the CI LOWER BOUND clears the threshold.
 *  Judging is least reliable when candidates are close (research-report §2.2),
 *  so the point estimate is never allowed to decide the gate. */
export function gate(uplift: ConfidenceInterval, threshold: number): { threshold: number; pass: boolean } {
  return { threshold, pass: uplift.lo >= threshold };
}
