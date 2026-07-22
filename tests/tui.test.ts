import { describe, expect, it } from 'vitest';
import { bar, dimensionBars, renderResultCharts, sparkline, upliftGauge, signed } from '../src/tui/charts.js';
import { bigText } from '../src/tui/banner.js';
import { spinnerFrame } from '../src/tui/spinner.js';
import { availableCharts, drawChart, resultDigest, type LastResult } from '../src/tui/result-context.js';
import type { RunResult } from '../src/types.js';

// A minimal RunResult for chart/digest tests.
function makeResult(over: Partial<RunResult> = {}): RunResult {
  return {
    headline: {
      winRate: { estimate: 0.62, lo: 0.5, hi: 0.74, method: 'wilson' },
      uplift: { estimate: 0.23, lo: -0.07, hi: 0.56, method: 'cluster-bootstrap' },
      gate: { threshold: 0.4, pass: false },
    },
    dimensions: [
      { dimension: 'correctness', repoScore: 1, baselineScore: 1, uplift: 0, weight: 0.4, modulesMeasured: 3, inUplift: true },
      { dimension: 'security', repoScore: null, baselineScore: null, uplift: 0, weight: 0.25, modulesMeasured: 0, inUplift: false },
      { dimension: 'maintainability', repoScore: 0.88, baselineScore: 0.71, uplift: 0.24, weight: 0.2, modulesMeasured: 3, inUplift: true },
      { dimension: 'consistency', repoScore: 1, baselineScore: 0.62, uplift: 0.61, weight: 0.15, modulesMeasured: 3, inUplift: true },
    ],
    outcomes: [
      { moduleId: 'm', dimension: 'correctness', winner: 'tie', method: 'deterministic' },
    ],
    meta: {
      repoRoot: '/r', modulesSampled: 3, modulesTotal: 7, specSource: 'extracted', baselineModel: 'codex-default',
      samplesPerSpec: 2, seed: 42, startedAt: 'a', finishedAt: 'b', toolVersions: {}, warnings: [],
    },
    ...over,
  };
}

describe('bar', () => {
  it('is exactly `width` columns and fills proportionally', () => {
    expect(bar(1, 10)).toBe('██████████');
    expect(bar(0, 10)).toBe('░'.repeat(10));
    const half = bar(0.5, 10);
    expect([...half]).toHaveLength(10);
    expect(half.startsWith('█████')).toBe(true);
  });

  it('clamps out-of-range and null values', () => {
    expect(bar(2, 6)).toBe('██████');
    expect(bar(null, 6)).toBe('░'.repeat(6));
  });
});

describe('sparkline', () => {
  it('maps the min to the lowest block and the max to the highest', () => {
    const s = sparkline([0, 1, 2, 3]);
    expect([...s]).toHaveLength(4);
    expect(s[0]).toBe('▁');
    expect(s[s.length - 1]).toBe('█');
  });
  it('is empty for no data', () => {
    expect(sparkline([])).toBe('');
  });
});

describe('upliftGauge', () => {
  it('marks the estimate and the gate and reads the pass state', () => {
    const below = upliftGauge(0.23, -0.07, 0.56, 0.4, { pass: false });
    expect(below).toContain('●'); // estimate marker
    expect(below).toContain('┃'); // gate marker
    expect(below).toContain('below the gate');
    expect(below).toContain(signed(0.23)); // "+23%"

    const clears = upliftGauge(0.6, 0.45, 0.75, 0.4, { pass: true });
    expect(clears).toContain('clears the gate');
  });
});

describe('dimensionBars', () => {
  it('shows both bars and the delta, and flags a not-measured dimension', () => {
    const out = dimensionBars(makeResult());
    expect(out).toContain('Correctness');
    expect(out).toContain('code');
    expect(out).toContain('zero-shot');
    expect(out).toContain('not measured'); // security is null on both sides
    expect(out).toContain(signed(0.61)); // consistency uplift arrow
  });
});

describe('renderResultCharts', () => {
  it('includes the win rate, the dimensions, and the uplift gauge', () => {
    const out = renderResultCharts(makeResult());
    expect(out).toContain('Win rate');
    expect(out).toContain('Uplift');
    expect(out).toContain('●');
  });
});

describe('bigText', () => {
  it('renders block glyphs with a drop-shadow row', () => {
    const rows = bigText('2BENCH');
    expect(rows).toHaveLength(6); // 5 face rows + 1 shadow row
    expect(rows[0]!.includes('█')).toBe(true); // bright face blocks
    expect(rows[5]!.includes('▒')).toBe(true); // the drop shadow, shaded
    // all rows are the same visible width (aligned glyphs + shadow)
    const widths = new Set(rows.map((r) => r.length));
    expect(widths.size).toBe(1);
  });
});

describe('spinnerFrame', () => {
  it('cycles and handles negative indices', () => {
    expect(spinnerFrame(0)).toBe(spinnerFrame(10));
    expect(typeof spinnerFrame(-1)).toBe('string');
    expect(spinnerFrame(-1)).not.toBe('');
  });
});

describe('result-context (digest + chart selection)', () => {
  it('summarizes a score result and offers the right charts', () => {
    const last: LastResult = { kind: 'score', result: makeResult() };
    const digest = resultDigest(last)!;
    expect(digest).toContain('uplift');
    expect(digest).toContain('correctness');
    expect(digest).toContain('not measured'); // security caveat travels into the digest

    expect(availableCharts(last)).toEqual(['result', 'dimensions', 'uplift', 'winrate']);
    expect(drawChart(last, 'result')).toContain('Uplift');
    expect(drawChart(last, 'history')).toBeNull(); // wrong chart for this result
  });

  it('offers only the history chart for a history result', () => {
    const last: LastResult = {
      kind: 'history',
      entries: [
        { at: '2026-07-20T00:00:00Z', repoRoot: '/r', subjectKind: 'codebase', subjectName: 'r', uplift: 0.1, upliftLo: 0, upliftHi: 0.2, winRate: 0.6, gatePass: false, gateThreshold: 0.4, modulesSampled: 3, specSource: 'linear', baselineModel: 'codex-default', dimensionUplift: {}, warnings: 0 },
        { at: '2026-07-21T00:00:00Z', repoRoot: '/r', subjectKind: 'codebase', subjectName: 'r', uplift: 0.25, upliftLo: 0.1, upliftHi: 0.4, winRate: 0.7, gatePass: false, gateThreshold: 0.4, modulesSampled: 3, specSource: 'linear', baselineModel: 'codex-default', dimensionUplift: {}, warnings: 0 },
      ],
    };
    expect(availableCharts(last)).toEqual(['history']);
    expect(drawChart(last, 'history')).toContain('Uplift trend');
  });

  it('has no digest or charts before anything runs', () => {
    expect(resultDigest(null)).toBeNull();
    expect(availableCharts(null)).toEqual([]);
    expect(drawChart(null, 'result')).toBeNull();
  });
});
