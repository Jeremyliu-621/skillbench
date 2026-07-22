import type { Contender, Dimension, DimensionScores, DeterministicScores, PairOutcome } from '../types.js';

/**
 * Scoring mapping: the bridge from raw scanner sub-scores + judged verdicts to
 * the four scored dimensions and the head-to-head outcomes that feed statistics.
 *
 * Two headline numbers come out of this (research-report.md §2.6):
 *  - WIN RATE: one PairOutcome per (module, dimension). Decided deterministically
 *    when both sides have a numeric score for that dimension; otherwise by the
 *    LLM judge (the "residual"). Ties within EPSILON.
 *  - UPLIFT: (repo − baseline)/baseline per dimension, computed ONLY over
 *    dimensions with a numeric score on both sides. Judge-only dimensions count
 *    toward win rate but not the uplift % (we don't invent numbers from a binary
 *    verdict). As deterministic coverage grows (e.g. D1 adds correctness tests),
 *    more dimensions enter the uplift automatically.
 *
 * Dimension composition from sub-scores:
 *  - correctness     = testPassRate, blended with mutationScore when present
 *                      (mutation weighted higher than coverage, per Just et al.).
 *  - security        = deterministic security sub-score (semgrep + secrets).
 *  - maintainability = mean of available {complexityHealth, duplication, lint}.
 *                      complexityHealth is always present, so this is never null.
 *  - consistency     = a module-level property: the delivered repo artifact is
 *                      fixed (score 1.0) while the vanilla baseline varies across
 *                      regenerations (measured stability). This encodes exactly
 *                      the common claim that shipped code is more deterministic
 *                      than re-prompting an LLM. Only scored when ≥2 baseline
 *                      candidates gave a stability measurement.
 */

export const TIE_EPSILON = 0.02;
const MUTATION_WEIGHT = 0.4; // correctness = 0.6*tests + 0.4*mutation when both exist

/** Compose the three scanner-derived dimensions for one implementation. */
export function dimensionsFromDeterministic(d: DeterministicScores): Omit<DimensionScores, 'consistency'> {
  return {
    correctness: correctnessScore(d),
    security: d.security,
    maintainability: maintainabilityScore(d),
  };
}

export function correctnessScore(d: DeterministicScores): number | null {
  if (d.testPassRate === null) return null;
  if (d.mutationScore === null) return d.testPassRate;
  return (1 - MUTATION_WEIGHT) * d.testPassRate + MUTATION_WEIGHT * d.mutationScore;
}

export function maintainabilityScore(d: DeterministicScores): number {
  const parts = [d.complexityHealth, d.duplication, d.lintCleanliness].filter(
    (x): x is number => x !== null,
  );
  // complexityHealth is always present, so parts is never empty.
  return parts.reduce((a, b) => a + b, 0) / parts.length;
}

/**
 * Build the per-dimension scores for both sides of one module.
 * `repoDet` / `baselineDet` are the deterministic scores; `baselineStability`
 * is the D3 consistency measurement across the baseline candidates (or null).
 */
export function moduleDimensionScores(input: {
  repoDet: DeterministicScores;
  baselineDet: DeterministicScores;
  baselineStability: number | null;
}): { repo: DimensionScores; baseline: DimensionScores } {
  const repo = dimensionsFromDeterministic(input.repoDet);
  const baseline = dimensionsFromDeterministic(input.baselineDet);
  return {
    repo: {
      ...repo,
      consistency: input.baselineStability === null ? null : 1, // fixed artifact
    },
    baseline: {
      ...baseline,
      consistency: input.baselineStability,
    },
  };
}

/** Decide a deterministic head-to-head on a numeric dimension. */
export function compareScores(repo: number, baseline: number): Exclude<PairOutcome['winner'], never> {
  if (Math.abs(repo - baseline) <= TIE_EPSILON) return 'tie';
  return repo > baseline ? 'repo' : 'baseline';
}

/**
 * Produce the outcomes for one module across all four dimensions. Deterministic
 * where both sides have a score; otherwise falls back to the supplied judged
 * outcome for that dimension (if any). Dimensions with neither are omitted.
 */
export function moduleOutcomes(input: {
  moduleId: string;
  scores: { repo: DimensionScores; baseline: DimensionScores };
  judged?: Partial<Record<Dimension, PairOutcome['winner']>>;
}): PairOutcome[] {
  const dims: Dimension[] = ['correctness', 'security', 'maintainability', 'consistency'];
  const outcomes: PairOutcome[] = [];
  for (const dimension of dims) {
    const r = input.scores.repo[dimension];
    const b = input.scores.baseline[dimension];
    if (r !== null && b !== null) {
      outcomes.push({
        moduleId: input.moduleId,
        dimension,
        winner: compareScores(r, b),
        method: 'deterministic',
        detail: `repo=${r.toFixed(3)} baseline=${b.toFixed(3)}`,
      });
    } else if (input.judged?.[dimension]) {
      outcomes.push({
        moduleId: input.moduleId,
        dimension,
        winner: input.judged[dimension]!,
        method: 'judged',
      });
    }
  }
  return outcomes;
}

/** Winner as a contender label helper (used by tests / reports). */
export function contenderOf(winner: PairOutcome['winner']): Contender | 'tie' {
  return winner;
}
