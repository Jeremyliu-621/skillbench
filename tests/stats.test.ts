import { describe, expect, it } from 'vitest';
import { wilson } from '../src/stats/wilson.js';
import { bootstrapCI, clusterBootstrapCI, mean } from '../src/stats/bootstrap.js';
import {
  BASELINE_FLOOR,
  aggregateDimensions,
  compositeUplift,
  gate,
  relativeUplift,
  winRate,
} from '../src/stats/aggregate.js';
import type { DimensionResult, DimensionScores, PairOutcome } from '../src/types.js';

describe('wilson', () => {
  it('matches known values for 8/10 at 95%', () => {
    const ci = wilson(8, 10);
    expect(ci.estimate).toBeCloseTo(0.8, 10);
    // Reference values for the Wilson interval on p̂=0.8, n=10.
    expect(ci.lo).toBeCloseTo(0.49, 2);
    expect(ci.hi).toBeCloseTo(0.943, 2);
  });

  it('never leaves [0,1] even at extremes', () => {
    const zero = wilson(0, 10);
    const all = wilson(10, 10);
    expect(zero.lo).toBe(0);
    expect(zero.hi).toBeGreaterThan(0); // unlike CLT, no zero-width interval at 0%
    expect(all.hi).toBe(1);
    expect(all.lo).toBeLessThan(1);
  });

  it('handles n=0 without dividing by zero', () => {
    expect(wilson(0, 0)).toMatchObject({ lo: 0, hi: 1 });
  });

  it('accepts fractional successes (ties as half-wins)', () => {
    const ci = wilson(7.5, 10);
    expect(ci.estimate).toBeCloseTo(0.75, 10);
  });
});

describe('bootstrapCI', () => {
  it('is deterministic under a fixed seed', () => {
    const values = [0.1, 0.4, 0.35, 0.6, 0.2, 0.5, 0.45, 0.3];
    const a = bootstrapCI(values, { seed: 7 });
    const b = bootstrapCI(values, { seed: 7 });
    expect(a).toEqual(b);
  });

  it('brackets the sample mean', () => {
    const values = [0.42, 0.51, 0.38, 0.6, 0.47, 0.55, 0.44, 0.49, 0.52, 0.41];
    const ci = bootstrapCI(values);
    expect(ci.lo).toBeLessThanOrEqual(mean(values));
    expect(ci.hi).toBeGreaterThanOrEqual(mean(values));
    expect(ci.estimate).toBeCloseTo(mean(values), 10);
  });

  it('rejects empty input', () => {
    expect(() => bootstrapCI([])).toThrow();
  });
});

describe('clusterBootstrapCI', () => {
  const clustered = (vals: [number, string][]) => vals.map(([value, cluster]) => ({ value, cluster }));

  it('is deterministic under a fixed seed', () => {
    const data = clustered([[0.2, 'api'], [0.3, 'api'], [0.6, 'ui'], [0.5, 'ui'], [0.4, 'lib']]);
    expect(clusterBootstrapCI(data, { seed: 7 })).toEqual(clusterBootstrapCI(data, { seed: 7 }));
  });

  it('widens the interval versus the naive bootstrap when values cluster', () => {
    // Two tight clusters far apart: cluster identity carries most of the
    // variance, so resampling clusters must produce a wider interval.
    const data = clustered([
      [0.1, 'a'], [0.11, 'a'], [0.12, 'a'], [0.09, 'a'],
      [0.9, 'b'], [0.91, 'b'], [0.89, 'b'], [0.92, 'b'],
    ]);
    const clusterCI = clusterBootstrapCI(data, { seed: 3 });
    const naiveCI = bootstrapCI(data.map((d) => d.value), { seed: 3 });
    expect(clusterCI.method).toBe('cluster-bootstrap');
    expect(clusterCI.hi - clusterCI.lo).toBeGreaterThan(naiveCI.hi - naiveCI.lo);
  });

  it('falls back to the plain bootstrap when every cluster is a singleton', () => {
    const data = clustered([[0.1, 'a'], [0.2, 'b'], [0.3, 'c']]);
    const ci = clusterBootstrapCI(data, { seed: 5 });
    expect(ci.method).toBe('bootstrap-percentile');
    expect(ci).toEqual(bootstrapCI([0.1, 0.2, 0.3], { seed: 5 }));
  });
});

describe('aggregate', () => {
  const outcome = (winner: PairOutcome['winner']): PairOutcome => ({
    moduleId: 'm',
    dimension: 'correctness',
    winner,
    method: 'deterministic',
  });

  it('counts ties as half-wins in the win rate', () => {
    const rate = winRate([outcome('repo'), outcome('repo'), outcome('tie'), outcome('baseline')]);
    expect(rate.estimate).toBeCloseTo(2.5 / 4, 10);
  });

  it('computes relative uplift with a floor against divide-by-zero', () => {
    expect(relativeUplift(0.9, 0.6)).toBeCloseTo(0.5, 10);
    expect(relativeUplift(0.5, 0)).toBeCloseTo((0.5 - BASELINE_FLOOR) / BASELINE_FLOOR, 10);
  });

  it('weights measured dimension uplifts into the composite (renormalized)', () => {
    const dims: DimensionResult[] = [
      { dimension: 'correctness', repoScore: 0.9, baselineScore: 0.6, uplift: 0.5, weight: 0.4, modulesMeasured: 3, inUplift: true },
      { dimension: 'security', repoScore: 0.8, baselineScore: 0.5, uplift: 0.6, weight: 0.25, modulesMeasured: 3, inUplift: true },
      { dimension: 'maintainability', repoScore: 0.7, baselineScore: 0.7, uplift: 0, weight: 0.2, modulesMeasured: 3, inUplift: true },
      { dimension: 'consistency', repoScore: 0.6, baselineScore: 0.4, uplift: 0.5, weight: 0.15, modulesMeasured: 3, inUplift: true },
    ];
    // All four measured ⇒ weights already sum to 1 ⇒ renormalization is a no-op.
    const expected = 0.4 * 0.5 + 0.25 * 0.6 + 0.2 * 0 + 0.15 * 0.5;
    expect(compositeUplift(dims)).toBeCloseTo(expected, 10);
  });

  it('renormalizes weights when a dimension is unmeasured', () => {
    const dims: DimensionResult[] = [
      { dimension: 'correctness', repoScore: null, baselineScore: null, uplift: 0, weight: 0.4, modulesMeasured: 0, inUplift: false },
      { dimension: 'security', repoScore: 0.8, baselineScore: 0.5, uplift: 0.6, weight: 0.25, modulesMeasured: 3, inUplift: true },
      { dimension: 'maintainability', repoScore: 0.7, baselineScore: 0.5, uplift: 0.4, weight: 0.2, modulesMeasured: 3, inUplift: true },
      { dimension: 'consistency', repoScore: 1, baselineScore: 0.5, uplift: 1, weight: 0.15, modulesMeasured: 3, inUplift: true },
    ];
    // correctness excluded; remaining weights 0.25/0.2/0.15 renormalized to sum 1.
    const wsum = 0.25 + 0.2 + 0.15;
    const expected = (0.25 * 0.6 + 0.2 * 0.4 + 0.15 * 1) / wsum;
    expect(compositeUplift(dims)).toBeCloseTo(expected, 10);
  });
});

describe('aggregateDimensions', () => {
  const weights = { correctness: 0.4, security: 0.25, maintainability: 0.2, consistency: 0.15 };
  const mod = (
    repo: Partial<DimensionScores>,
    baseline: Partial<DimensionScores>,
  ): { repo: DimensionScores; baseline: DimensionScores } => ({
    repo: { correctness: null, security: null, maintainability: null, consistency: null, ...repo },
    baseline: { correctness: null, security: null, maintainability: null, consistency: null, ...baseline },
  });

  it('averages per-dimension scores over measured modules and marks coverage', () => {
    const { dimensions } = aggregateDimensions(
      [
        mod({ maintainability: 0.9, security: 0.8 }, { maintainability: 0.6, security: 0.5 }),
        mod({ maintainability: 0.7 }, { maintainability: 0.5 }),
      ],
      weights,
    );
    const maint = dimensions.find((d) => d.dimension === 'maintainability')!;
    expect(maint.modulesMeasured).toBe(2);
    expect(maint.repoScore).toBeCloseTo(0.8, 10);
    expect(maint.baselineScore).toBeCloseTo(0.55, 10);

    const sec = dimensions.find((d) => d.dimension === 'security')!;
    expect(sec.modulesMeasured).toBe(1);

    const corr = dimensions.find((d) => d.dimension === 'correctness')!;
    expect(corr.inUplift).toBe(false);
    expect(corr.modulesMeasured).toBe(0);
  });

  it('produces per-module composite uplifts aligned with input (null = unmeasured)', () => {
    const { perModuleCompositeUplift } = aggregateDimensions(
      [
        mod({ maintainability: 0.9 }, { maintainability: 0.6 }),
        mod({}, {}), // measured nothing → null, position preserved
      ],
      weights,
    );
    expect(perModuleCompositeUplift).toHaveLength(2);
    expect(perModuleCompositeUplift[0]).toBeCloseTo(relativeUplift(0.9, 0.6), 10);
    expect(perModuleCompositeUplift[1]).toBeNull();
  });

  it('gates on the CI lower bound, not the point estimate', () => {
    const ci = { estimate: 0.55, lo: 0.38, hi: 0.72, method: 'bootstrap-percentile' as const };
    expect(gate(ci, 0.4).pass).toBe(false); // estimate clears 0.4 but lo does not
    expect(gate(ci, 0.35).pass).toBe(true);
  });
});
