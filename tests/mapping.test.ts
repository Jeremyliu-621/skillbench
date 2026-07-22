import { describe, expect, it } from 'vitest';
import {
  TIE_EPSILON,
  compareScores,
  correctnessScore,
  dimensionsFromDeterministic,
  maintainabilityScore,
  moduleDimensionScores,
  moduleOutcomes,
} from '../src/stages/mapping.js';
import type { DeterministicScores } from '../src/types.js';

const det = (over: Partial<DeterministicScores> = {}): DeterministicScores => ({
  testPassRate: null,
  mutationScore: null,
  security: null,
  duplication: null,
  complexityHealth: 0.9,
  lintCleanliness: null,
  secretCount: null,
  stability: null,
  ...over,
});

describe('correctnessScore', () => {
  it('is null without tests', () => {
    expect(correctnessScore(det())).toBeNull();
  });
  it('is the pass rate when mutation is absent', () => {
    expect(correctnessScore(det({ testPassRate: 0.8 }))).toBe(0.8);
  });
  it('weights mutation at 0.4 when present', () => {
    expect(correctnessScore(det({ testPassRate: 0.8, mutationScore: 0.3 }))).toBeCloseTo(
      0.6 * 0.8 + 0.4 * 0.3,
      10,
    );
  });
});

describe('maintainabilityScore', () => {
  it('is complexity alone when other scanners are absent', () => {
    expect(maintainabilityScore(det({ complexityHealth: 0.75 }))).toBe(0.75);
  });
  it('averages available sub-scores', () => {
    expect(
      maintainabilityScore(det({ complexityHealth: 0.9, duplication: 0.6, lintCleanliness: 0.3 })),
    ).toBeCloseTo((0.9 + 0.6 + 0.3) / 3, 10);
  });
});

describe('compareScores', () => {
  it('calls near-equal scores a tie', () => {
    expect(compareScores(0.8, 0.8 + TIE_EPSILON / 2)).toBe('tie');
  });
  it('picks the clear winner', () => {
    expect(compareScores(0.9, 0.6)).toBe('repo');
    expect(compareScores(0.5, 0.9)).toBe('baseline');
  });
});

describe('moduleDimensionScores', () => {
  it('sets repo consistency to 1 (fixed artifact) and baseline to measured stability', () => {
    const { repo, baseline } = moduleDimensionScores({
      repoDet: det({ complexityHealth: 0.8 }),
      baselineDet: det({ complexityHealth: 0.6 }),
      baselineStability: 0.55,
    });
    expect(repo.consistency).toBe(1);
    expect(baseline.consistency).toBe(0.55);
    expect(repo.maintainability).toBe(0.8);
  });
  it('leaves consistency null when stability was not measured', () => {
    const { repo, baseline } = moduleDimensionScores({
      repoDet: det(),
      baselineDet: det(),
      baselineStability: null,
    });
    expect(repo.consistency).toBeNull();
    expect(baseline.consistency).toBeNull();
  });
});

describe('moduleOutcomes', () => {
  it('emits deterministic outcomes where both sides have a score', () => {
    const scores = moduleDimensionScores({
      repoDet: det({ complexityHealth: 0.9, security: 0.9 }),
      baselineDet: det({ complexityHealth: 0.6, security: 0.4 }),
      baselineStability: 0.5,
    });
    const outcomes = moduleOutcomes({ moduleId: 'm', scores });
    const byDim = Object.fromEntries(outcomes.map((o) => [o.dimension, o]));
    expect(byDim.maintainability!.method).toBe('deterministic');
    expect(byDim.maintainability!.winner).toBe('repo');
    expect(byDim.security!.winner).toBe('repo');
    expect(byDim.consistency!.winner).toBe('repo'); // 1.0 vs 0.5
    expect(byDim.correctness).toBeUndefined(); // no tests, no judge → omitted
  });

  it('falls back to a judged verdict when a dimension has no deterministic score', () => {
    const scores = moduleDimensionScores({
      repoDet: det(),
      baselineDet: det(),
      baselineStability: null,
    });
    const outcomes = moduleOutcomes({
      moduleId: 'm',
      scores,
      judged: { correctness: 'baseline' },
    });
    const corr = outcomes.find((o) => o.dimension === 'correctness')!;
    expect(corr.method).toBe('judged');
    expect(corr.winner).toBe('baseline');
  });
});

describe('dimensionsFromDeterministic', () => {
  it('never returns null maintainability (complexity is always present)', () => {
    expect(dimensionsFromDeterministic(det()).maintainability).not.toBeNull();
  });
});
