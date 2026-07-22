import { describe, expect, it } from 'vitest';
import {
  consistencyScore,
  cosineSimilarity,
  meanPairwiseSimilarity,
  passRateStability,
  termFrequency,
  tokenize,
} from '../src/scanners/consistency.js';

describe('tokenize', () => {
  it('splits into identifiers, numbers, and punctuation, ignoring whitespace', () => {
    expect(tokenize('const x = 1 + 2;')).toEqual(['const', 'x', '=', '1', '+', '2', ';']);
  });
});

describe('cosineSimilarity', () => {
  it('is 1 for identical token bags', () => {
    const a = termFrequency(tokenize('function f(){ return 1; }'));
    expect(cosineSimilarity(a, a)).toBeCloseTo(1, 10);
  });
  it('is lower for divergent code than for identical code', () => {
    const a = termFrequency(tokenize('function f(){ return 1; }'));
    const b = termFrequency(tokenize('class Zeta { method() { throw new Error(); } }'));
    // Raw token cosine keeps shared punctuation, so divergent short snippets still
    // share a floor (~0.6); the guarantee is only that it's below the identical case.
    expect(cosineSimilarity(a, b)).toBeLessThan(cosineSimilarity(a, a));
  });
});

describe('meanPairwiseSimilarity', () => {
  it('returns 1 for a single source (nothing to disagree with)', () => {
    expect(meanPairwiseSimilarity(['whatever'])).toBe(1);
  });
  it('returns 1 for K identical outputs (perfectly stable regeneration)', () => {
    const src = 'export function tax(x){ return x * 0.13; }';
    expect(meanPairwiseSimilarity([src, src, src])).toBeCloseTo(1, 10);
  });
  it('is high for near-identical and low for wildly different outputs', () => {
    const stable = meanPairwiseSimilarity([
      'function tax(x){ return x * 0.13; }',
      'function tax(x){ return x * 0.13; } ',
    ]);
    const unstable = meanPairwiseSimilarity([
      'function tax(x){ return x * 0.13; }',
      'const compute = (amount) => amount / 8;',
    ]);
    expect(stable).toBeGreaterThan(unstable);
    expect(stable).toBeGreaterThan(0.9);
    // Dropping shared punctuation gives real discrimination for divergent code.
    expect(unstable).toBeLessThan(0.5);
  });
});

describe('passRateStability', () => {
  it('is null with fewer than two measured rates', () => {
    expect(passRateStability([0.5, null])).toBeNull();
  });
  it('is 1 when all rates agree', () => {
    expect(passRateStability([0.8, 0.8, 0.8])).toBeCloseTo(1, 10);
  });
  it('is 0 when maximally split', () => {
    expect(passRateStability([0, 1])).toBeCloseTo(0, 10);
  });
});

describe('consistencyScore', () => {
  it('uses code similarity alone when no pass rates are given', () => {
    const src = 'export const a = 1;';
    expect(consistencyScore({ sources: [src, src] })).toBeCloseTo(1, 10);
  });
  it('averages code similarity and behavioral stability when both exist', () => {
    const src = 'export const a = 1;'; // similarity ~1
    const score = consistencyScore({ sources: [src, src], passRates: [0, 1] }); // stability 0
    expect(score).toBeCloseTo(0.5, 5);
  });
});
