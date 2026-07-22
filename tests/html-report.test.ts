import { describe, expect, it } from 'vitest';
import { renderHtmlReport } from '../src/report/html-report.js';
import type { RunResult } from '../src/types.js';

function baseResult(over: Partial<RunResult> = {}): RunResult {
  return {
    headline: {
      winRate: { estimate: 0.85, lo: 0.72, hi: 0.93, method: 'wilson' },
      uplift: { estimate: 0.62, lo: 0.44, hi: 0.81, method: 'bootstrap-percentile' },
      gate: { threshold: 0.4, pass: true },
    },
    dimensions: [
      { dimension: 'correctness', repoScore: 0.9, baselineScore: 0.6, uplift: 0.5, weight: 0.4, modulesMeasured: 3, inUplift: true },
      { dimension: 'security', repoScore: 0.8, baselineScore: 0.5, uplift: 0.6, weight: 0.25, modulesMeasured: 3, inUplift: true },
      { dimension: 'maintainability', repoScore: 0.85, baselineScore: 0.7, uplift: 0.21, weight: 0.2, modulesMeasured: 3, inUplift: true },
      { dimension: 'consistency', repoScore: null, baselineScore: null, uplift: 0, weight: 0.15, modulesMeasured: 0, inUplift: false },
    ],
    outcomes: [
      { moduleId: 'm', dimension: 'maintainability', winner: 'repo', method: 'deterministic' },
      { moduleId: 'm', dimension: 'correctness', winner: 'tie', method: 'judged' },
    ],
    meta: {
      repoRoot: 'C:/clients/acme/erp',
      modulesSampled: 3,
      modulesTotal: 12,
      specSource: 'extracted',
      baselineModel: 'codex-default',
      samplesPerSpec: 3,
      seed: 42,
      startedAt: '2026-07-17T00:00:00.000Z',
      finishedAt: '2026-07-17T00:03:00.000Z',
      toolVersions: { codex: 'codex-cli 0.144.5', jscpd: 'cpd 5.0.12' },
      warnings: [],
    },
    ...over,
  };
}

describe('renderHtmlReport', () => {
  it('produces a self-contained HTML document (no external asset URLs)', () => {
    const html = renderHtmlReport(baseResult());
    expect(html).toMatch(/^<!doctype html>/i);
    expect(html).toContain('</html>');
    expect(html).not.toMatch(/https?:\/\/[^"']*\.(css|js|woff2?|png|svg)/i);
    expect(html).not.toContain('<script');
  });

  it('shows the verdict, headline metrics, and their CIs', () => {
    const html = renderHtmlReport(baseResult());
    expect(html).toContain('PASS');
    expect(html).toContain('+62%'); // uplift estimate
    expect(html).toContain('85%'); // win rate
    expect(html).toMatch(/95% CI/);
  });

  it('renders REVIEW (not PASS) when the gate fails', () => {
    const html = renderHtmlReport(
      baseResult({
        headline: {
          winRate: { estimate: 0.5, lo: 0.3, hi: 0.7, method: 'wilson' },
          uplift: { estimate: 0.2, lo: -0.1, hi: 0.5, method: 'bootstrap-percentile' },
          gate: { threshold: 0.4, pass: false },
        },
      }),
    );
    expect(html).toContain('REVIEW');
    expect(html).not.toContain('>PASS<');
  });

  it('flags the extracted-spec validity caveat', () => {
    const html = renderHtmlReport(baseResult());
    expect(html.toLowerCase()).toContain('extracted from the code');
  });

  it('marks unmeasured dimensions as not measured, and escapes dynamic text', () => {
    const html = renderHtmlReport(
      baseResult({
        meta: { ...baseResult().meta, baselineModel: 'gpt-<x> & "y"' },
      }),
    );
    expect(html).toContain('not measured'); // consistency dim
    expect(html).toContain('gpt-&lt;x&gt; &amp; &quot;y&quot;'); // escaped
  });

  it('surfaces measurement caveats instead of hiding them', () => {
    const html = renderHtmlReport(
      baseResult({
        meta: { ...baseResult().meta, warnings: ['tax: correctness not scored — spec was extracted.'] },
      }),
    );
    expect(html).toContain('What we could not measure');
    expect(html).toContain('correctness not scored');
  });

  it('omits the caveats panel when there is nothing to caveat', () => {
    expect(renderHtmlReport(baseResult())).not.toContain('What we could not measure');
  });

  it('falls back to a health notice when there is no comparison', () => {
    const html = renderHtmlReport(
      baseResult({
        outcomes: [],
        dimensions: baseResult().dimensions.map((d) => ({ ...d, inUplift: false, modulesMeasured: 0 })),
      }),
    );
    expect(html).toContain('HEALTH');
    expect(html).toContain('no baseline comparison');
  });
});
