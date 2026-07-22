import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendHistory,
  parseHistory,
  readHistory,
  summarizeTrend,
  toHistoryEntry,
  type HistoryEntry,
} from '../src/history.js';
import { niceDomain, renderTrendChart } from '../src/report/trend-chart.js';
import type { RunResult } from '../src/types.js';

function runResult(uplift: number, over: Partial<RunResult['meta']> = {}): RunResult {
  return {
    headline: {
      winRate: { estimate: 0.8, lo: 0.6, hi: 0.9, method: 'wilson' },
      uplift: { estimate: uplift, lo: uplift - 0.1, hi: uplift + 0.1, method: 'cluster-bootstrap' },
      gate: { threshold: 0.4, pass: uplift - 0.1 >= 0.4 },
    },
    dimensions: [
      { dimension: 'correctness', repoScore: 0.9, baselineScore: 0.6, uplift: 0.5, weight: 0.4, modulesMeasured: 2, inUplift: true },
      { dimension: 'security', repoScore: null, baselineScore: null, uplift: 0, weight: 0.25, modulesMeasured: 0, inUplift: false },
      { dimension: 'maintainability', repoScore: 0.8, baselineScore: 0.7, uplift: 0.14, weight: 0.2, modulesMeasured: 2, inUplift: true },
      { dimension: 'consistency', repoScore: 1, baselineScore: 0.9, uplift: 0.11, weight: 0.15, modulesMeasured: 2, inUplift: true },
    ],
    outcomes: [],
    meta: {
      repoRoot: '/repo',
      modulesSampled: 3,
      modulesTotal: 10,
      specSource: 'extracted',
      baselineModel: 'codex-default',
      samplesPerSpec: 2,
      seed: 42,
      startedAt: '2026-07-20T00:00:00.000Z',
      finishedAt: '2026-07-20T00:05:00.000Z',
      toolVersions: {},
      warnings: [],
      ...over,
    },
  };
}

describe('toHistoryEntry', () => {
  it('captures the headline, the baseline model, and only measured dimensions', () => {
    const e = toHistoryEntry(runResult(0.35));
    expect(e.uplift).toBeCloseTo(0.35, 10);
    expect(e.baselineModel).toBe('codex-default');
    expect(Object.keys(e.dimensionUplift).sort()).toEqual(['consistency', 'correctness', 'maintainability']);
    expect(e.dimensionUplift.security).toBeUndefined(); // unmeasured stays out
  });
});

describe('history file', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), '2bench-hist-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('appends one line per run and reads them back oldest-first', async () => {
    await appendHistory(dir, runResult(0.1, { finishedAt: '2026-07-18T00:00:00.000Z' }));
    await appendHistory(dir, runResult(0.3, { finishedAt: '2026-07-19T00:00:00.000Z' }));
    const entries = await readHistory(dir);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.uplift).toBeCloseTo(0.1, 10);
    expect(entries[1]!.uplift).toBeCloseTo(0.3, 10);
    const raw = await readFile(join(dir, 'history.jsonl'), 'utf8');
    expect(raw.trim().split('\n')).toHaveLength(2);
  });

  it('returns empty history rather than throwing when there is no file', async () => {
    expect(await readHistory(join(dir, 'nope'))).toEqual([]);
  });

  it('skips corrupt lines instead of losing the whole history', () => {
    const good = JSON.stringify(toHistoryEntry(runResult(0.2)));
    expect(parseHistory(`${good}\nnot json\n{"partial":\n${good}\n`)).toHaveLength(2);
  });
});

describe('summarizeTrend', () => {
  const entry = (uplift: number, baselineModel = 'codex-default'): HistoryEntry =>
    toHistoryEntry(runResult(uplift, { baselineModel }));

  it('is null with no history', () => {
    expect(summarizeTrend([])).toBeNull();
  });

  it('reports no previous-run delta on the first run', () => {
    expect(summarizeTrend([entry(0.2)])!.deltaFromPrevious).toBeNull();
  });

  it('computes direction and deltas across runs', () => {
    const t = summarizeTrend([entry(0.1), entry(0.2), entry(0.5)])!;
    expect(t.runs).toBe(3);
    expect(t.deltaFromPrevious).toBeCloseTo(0.3, 10);
    expect(t.deltaFromFirst).toBeCloseTo(0.4, 10);
    expect(t.direction).toBe('up');
  });

  it('calls a tiny move flat rather than a trend', () => {
    expect(summarizeTrend([entry(0.2), entry(0.205)])!.direction).toBe('flat');
  });

  it('flags a baseline model change — the moving target', () => {
    const t = summarizeTrend([entry(0.5, 'gpt-5'), entry(0.2, 'gpt-6')])!;
    expect(t.baselineChanged).toBe(true);
    expect(t.direction).toBe('down');
  });
});

describe('renderTrendChart', () => {
  const entries = (vals: number[]) => vals.map((v) => toHistoryEntry(runResult(v)));

  it('renders nothing for fewer than two runs (no trend to show)', () => {
    expect(renderTrendChart([])).toBe('');
    expect(renderTrendChart(entries([0.3]))).toBe('');
  });

  it('renders an accessible SVG plus a table view, with no script', () => {
    const svg = renderTrendChart(entries([0.1, 0.3, 0.55]));
    expect(svg).toContain('<svg');
    expect(svg).toContain('role="img"');
    expect(svg).toContain('aria-label');
    expect(svg).toContain('<table>'); // non-visual path to the same data
    expect(svg).not.toContain('<script');
    expect(svg).toContain('<title>'); // hover detail per point
    expect(svg).toContain('gate +40%'); // threshold reference rule
  });

  it('keeps every plotted point inside the viewBox', () => {
    const svg = renderTrendChart(entries([-0.4, 0.2, 0.9]));
    const ys = [...svg.matchAll(/<circle cx="([\d.]+)" cy="([\d.]+)"/g)].map((m) => [
      Number(m[1]),
      Number(m[2]),
    ]);
    expect(ys).toHaveLength(3);
    for (const [cx, cy] of ys) {
      expect(cx).toBeGreaterThanOrEqual(0);
      expect(cx).toBeLessThanOrEqual(640);
      expect(cy).toBeGreaterThanOrEqual(0);
      expect(cy).toBeLessThanOrEqual(190);
    }
  });
});

describe('niceDomain', () => {
  it('always contains zero so negative uplift reads correctly', () => {
    const d = niceDomain([0.2, 0.5, 0]);
    expect(d.min).toBeLessThanOrEqual(0);
    const neg = niceDomain([-0.3, -0.1, 0]);
    expect(neg.min).toBeLessThanOrEqual(-0.3);
    expect(neg.max).toBeGreaterThanOrEqual(0);
  });
});

describe('parseHistory backward compatibility', () => {
  it('backfills fields added after a line was written', () => {
    // A line from an older build: no subjectKind/subjectName/warnings.
    const old = JSON.stringify({
      at: '2026-07-18T00:00:00.000Z',
      repoRoot: 'C:/clients/acme/erp',
      uplift: 0.3, upliftLo: 0.1, upliftHi: 0.5, winRate: 0.7,
      gatePass: false, gateThreshold: 0.4, modulesSampled: 3,
      specSource: 'extracted', baselineModel: 'codex-default',
    });
    const [e] = parseHistory(old);
    expect(e!.subjectKind).toBe('codebase');
    expect(e!.subjectName).toBe('acme/erp'); // derived from the path
    expect(e!.warnings).toBe(0);
    expect(e!.dimensionUplift).toEqual({});
  });

  it('still drops lines missing the fields that actually matter', () => {
    expect(parseHistory(JSON.stringify({ repoRoot: '/x' }))).toHaveLength(0);
  });
});
