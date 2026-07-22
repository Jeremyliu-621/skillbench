import { describe, expect, it } from 'vitest';
import {
  complexityOfSource,
  summarize,
  type FileComplexity,
} from '../src/scanners/complexity.js';
import { parseJscpd } from '../src/scanners/duplication.js';
import { parseSemgrep, applySecretPenalty } from '../src/scanners/security.js';
import { parseGitleaks } from '../src/scanners/secrets.js';
import { parseEslint } from '../src/scanners/lint.js';
import { cweWeight, densityToScore } from '../src/scanners/normalize.js';

describe('complexityOfSource', () => {
  it('scores a straight-line function as complexity 1', () => {
    const r = complexityOfSource('function f() { return 1 + 2; }');
    expect(r.functions).toHaveLength(1);
    expect(r.functions[0]!.complexity).toBe(1);
  });

  it('counts branch points (if/for/&&/ternary)', () => {
    const src = `function f(a, b) {
      if (a) { return 1; }          // +1
      for (let i = 0; i < 10; i++) {} // +1
      return a && b ? 1 : 2;        // && +1, ternary +1
    }`;
    // base 1 + 4 = 5
    expect(complexityOfSource(src).functions[0]!.complexity).toBe(5);
  });

  it('gives each nested function its own entry, not double-counted', () => {
    const src = `function outer() {
      if (true) {}
      const inner = (x) => x || 0;
    }`;
    const r = complexityOfSource(src);
    const outer = r.functions.find((f) => f.name === 'outer')!;
    const inner = r.functions.find((f) => f.name === 'inner')!;
    expect(outer.complexity).toBe(2); // base + if only (not inner's ||)
    expect(inner.complexity).toBe(2); // base + ||
  });

  it('does not crash on empty or trivial source', () => {
    expect(complexityOfSource('').functions).toHaveLength(0);
  });
});

describe('summarize (healthShare = distribution, not mean)', () => {
  const f = (loc: number, maxComplexity: number): FileComplexity => ({
    file: 'f.ts',
    loc,
    maxComplexity,
    functions: [],
  });

  it('is the LOC-share of files below the unhealthy threshold', () => {
    // 100 healthy loc, 100 unhealthy loc → 0.5 even though avg complexity is fine
    const report = summarize([f(100, 3), f(100, 40)]);
    expect(report.healthShare).toBeCloseTo(0.5, 10);
    expect(report.totalLoc).toBe(200);
  });

  it('is 1 for an empty set', () => {
    expect(summarize([]).healthShare).toBe(1);
  });
});

describe('parseJscpd', () => {
  it('turns duplicated percentage into 1 − fraction', () => {
    expect(parseJscpd({ statistics: { total: { percentage: 12.3 } } }).score).toBeCloseTo(0.877, 3);
  });
  it('defaults to a perfect score when the field is absent', () => {
    expect(parseJscpd({}).score).toBe(1);
  });
});

describe('parseSemgrep', () => {
  it('weights XSS findings above crypto findings', () => {
    const xss = parseSemgrep(
      { results: [{ check_id: 'xss.rule', extra: { severity: 'error', metadata: { cwe: 'CWE-79' } } }] },
      1000,
    );
    const crypto = parseSemgrep(
      { results: [{ check_id: 'weak.crypto', extra: { severity: 'error', metadata: { cwe: 'CWE-327' } } }] },
      1000,
    );
    expect(xss.weightedFindings).toBeGreaterThan(crypto.weightedFindings);
    expect(xss.score).toBeLessThan(crypto.score); // worse score for the XSS repo
  });

  it('scores clean code as 1', () => {
    expect(parseSemgrep({ results: [] }, 500).score).toBe(1);
  });
});

describe('applySecretPenalty', () => {
  it('lowers the security score when secrets are present', () => {
    const base = parseSemgrep({ results: [] }, 1000);
    const penalized = applySecretPenalty(base, 3, 1000);
    expect(penalized.score).toBeLessThan(base.score);
    expect(penalized.byClass.secret).toBe(3);
  });
  it('is a no-op when there are no secrets', () => {
    const base = parseSemgrep({ results: [] }, 1000);
    expect(applySecretPenalty(base, 0, 1000)).toEqual(base);
  });
});

describe('parseGitleaks / parseEslint', () => {
  it('counts gitleaks findings', () => {
    expect(parseGitleaks([{ rule: 'a' }, { rule: 'b' }]).count).toBe(2);
    expect(parseGitleaks(null).count).toBe(0);
  });
  it('aggregates eslint error/warning counts into a density score', () => {
    const r = parseEslint([{ errorCount: 15, warningCount: 0 }], 1000);
    expect(r.errorCount).toBe(15);
    expect(r.score).toBeCloseTo(0, 5); // 15 errors/kloc = ceiling = 0
  });
});

describe('normalize helpers', () => {
  it('cweWeight ranks sanitization classes highest', () => {
    expect(cweWeight('CWE-79 xss')).toBeGreaterThan(cweWeight('CWE-89 sql injection'));
    expect(cweWeight('CWE-89 injection')).toBeGreaterThan(cweWeight('CWE-327 crypto'));
    expect(cweWeight('nothing special')).toBe(1);
  });
  it('densityToScore maps zero findings to 1 and the ceiling to 0', () => {
    expect(densityToScore(0, 1000, 8)).toBe(1);
    expect(densityToScore(8, 1000, 8)).toBeCloseTo(0, 10);
    expect(densityToScore(4, 1000, 8)).toBeCloseTo(0.5, 10);
  });
});
