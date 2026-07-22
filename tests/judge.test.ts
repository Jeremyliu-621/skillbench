import { describe, expect, it } from 'vitest';
import { reconcileSwappedVerdicts, truncateForJudge } from '../src/stages/judge.js';
import type { JudgeVerdict } from '../src/types.js';

const v = (winner: JudgeVerdict['winner']): JudgeVerdict => ({
  winner,
  confidence: 'high',
  reasons: '',
});

describe('reconcileSwappedVerdicts', () => {
  // pass1: repo=A, baseline=B.  pass2 (swapped): repo=B, baseline=A.
  it('repo wins when both passes agree on repo', () => {
    expect(reconcileSwappedVerdicts(v('A'), v('B'))).toBe('repo');
  });

  it('baseline wins when both passes agree on baseline', () => {
    expect(reconcileSwappedVerdicts(v('B'), v('A'))).toBe('baseline');
  });

  it('agreement on tie stays a tie', () => {
    expect(reconcileSwappedVerdicts(v('tie'), v('tie'))).toBe('tie');
  });

  it('position-confounded disagreement becomes a tie', () => {
    // Judge picked "A" both times — i.e., whatever was listed first. Classic
    // position bias; must not count as a win for either side.
    expect(reconcileSwappedVerdicts(v('A'), v('A'))).toBe('tie');
    expect(reconcileSwappedVerdicts(v('B'), v('B'))).toBe('tie');
  });

  it('half-tie disagreements become ties', () => {
    expect(reconcileSwappedVerdicts(v('A'), v('tie'))).toBe('tie');
    expect(reconcileSwappedVerdicts(v('tie'), v('B'))).toBe('tie');
  });
});

describe('truncateForJudge', () => {
  it('passes short code through unchanged', () => {
    expect(truncateForJudge('const a = 1;')).toBe('const a = 1;');
  });

  it('caps long code, keeps head and tail, and marks the elision', () => {
    const code = 'H'.repeat(700) + 'M'.repeat(600) + 'T'.repeat(700);
    const out = truncateForJudge(code, 1000);
    expect(out.length).toBeLessThan(code.length);
    expect(out.startsWith('H')).toBe(true);
    expect(out.endsWith('T')).toBe(true);
    expect(out).toContain('characters elided for judging');
  });
});
