import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderDashboard, sparkline, type TrackedSubject } from '../src/report/dashboard.js';
import { discoverHistories, type HistoryEntry } from '../src/history.js';

function entry(over: Partial<HistoryEntry> = {}): HistoryEntry {
  return {
    at: '2026-07-20T00:00:00.000Z',
    repoRoot: '/clients/acme/erp',
    subjectKind: 'codebase',
    subjectName: 'acme/erp',
    uplift: 0.5,
    upliftLo: 0.42,
    upliftHi: 0.6,
    winRate: 0.8,
    gatePass: true,
    gateThreshold: 0.4,
    modulesSampled: 5,
    specSource: 'linear',
    baselineModel: 'codex-default',
    dimensionUplift: { correctness: 0.5 },
    warnings: 0,
    ...over,
  };
}

const subject = (entries: HistoryEntry[], source = '/x'): TrackedSubject => ({ source, entries });

describe('renderDashboard', () => {
  const data = {
    generatedAt: '2026-07-20T12:00:00.000Z',
    subjects: [
      subject([entry({ uplift: 0.1 }), entry({ uplift: 0.5 })]),
      subject([
        entry({ subjectName: 'tax skill', subjectKind: 'skill', uplift: 0.16, upliftLo: -0.07, gatePass: false }),
      ]),
    ],
  };

  it('is a self-contained page with no scripts or external assets', () => {
    const html = renderDashboard(data);
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).not.toContain('<script');
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js|woff2?|png|svg)/i);
  });

  it('lists every subject, labelled by kind, sorted by uplift', () => {
    const html = renderDashboard(data);
    expect(html).toContain('acme/erp');
    expect(html).toContain('tax skill');
    expect(html).toContain('>skill<');
    expect(html).toContain('>codebase<');
    expect(html.indexOf('acme/erp')).toBeLessThan(html.indexOf('tax skill')); // +50% before +16%
  });

  it('states status in words, not color alone', () => {
    const html = renderDashboard(data);
    expect(html).toContain('✓ clears');
    expect(html).toContain('• below');
  });

  it('summarises how many clear the bar', () => {
    expect(renderDashboard(data)).toContain('1/2');
  });

  it('warns when a subject has only one run (no trend yet)', () => {
    expect(renderDashboard(data)).toContain('only one recorded run');
  });

  it('surfaces caveat counts and baseline-model changes', () => {
    const html = renderDashboard({
      generatedAt: 'x',
      subjects: [
        subject([
          entry({ baselineModel: 'gpt-5' }),
          entry({ baselineModel: 'gpt-6', warnings: 2 }),
        ]),
      ],
    });
    expect(html).toContain('⚠ 2');
    expect(html).toContain('model↑');
  });

  it('renders an empty state rather than a broken page', () => {
    const html = renderDashboard({ subjects: [], generatedAt: 'x' });
    expect(html).toContain('No results yet');
    expect(html).toContain('history.jsonl');
  });

  it('escapes subject names', () => {
    const html = renderDashboard({
      generatedAt: 'x',
      subjects: [subject([entry({ subjectName: '<img src=x>' })])],
    });
    expect(html).toContain('&lt;img src=x&gt;');
    expect(html).not.toContain('<img src=x>');
  });
});

describe('sparkline', () => {
  it('is empty for no data and a dot for a single run', () => {
    expect(sparkline([])).toBe('');
    expect(sparkline([0.3])).toContain('circle');
  });

  it('draws a zero rule and an emphasized endpoint, all inside the viewBox', () => {
    const svg = sparkline([-0.2, 0.1, 0.6]);
    expect(svg).toContain('class="zero"');
    expect(svg).toContain('class="end"');
    expect(svg).toContain('role="img"');
    const pts = [...svg.matchAll(/[ML]([\d.]+),([\d.]+)/g)].map((m) => [Number(m[1]), Number(m[2])]);
    expect(pts).toHaveLength(3);
    for (const [x, y] of pts) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(132);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(30);
    }
  });
});

describe('discoverHistories', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), '2bench-dash-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const writeHistory = async (dir: string, name: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'history.jsonl'), `${JSON.stringify(entry({ subjectName: name }))}\n`, 'utf8');
  };

  it('finds a history directly in the given directory', async () => {
    await writeHistory(root, 'direct');
    const found = await discoverHistories([root]);
    expect(found).toHaveLength(1);
    expect(found[0]!.entries[0]!.subjectName).toBe('direct');
  });

  it('finds histories one level down (a folder per client)', async () => {
    await writeHistory(join(root, 'clientA'), 'A');
    await writeHistory(join(root, 'clientB'), 'B');
    const found = await discoverHistories([root]);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.entries[0]!.subjectName).sort()).toEqual(['A', 'B']);
  });

  it('ignores directories with no history and never double-counts', async () => {
    await writeHistory(root, 'direct');
    await mkdir(join(root, 'empty'), { recursive: true });
    expect(await discoverHistories([root, root])).toHaveLength(1);
  });

  it('returns nothing for a missing path instead of throwing', async () => {
    expect(await discoverHistories([join(root, 'nope')])).toEqual([]);
  });
});
