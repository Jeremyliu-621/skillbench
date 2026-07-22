/**
 * The bridge between "a command just ran" and "the agent can explain it, with a
 * real chart." The REPL stashes the most recent command's structured result as a
 * `LastResult`; from it we derive:
 *   - a compact text DIGEST fed to the concierge so it can explain in words, and
 *   - the set of CHARTS drawable from that result, plus the drawing itself.
 * Charts are always rendered here from real data — the LLM only *chooses* one.
 */
import type { RunResult } from '../types.js';
import type { HistoryEntry } from '../history.js';
import { c } from './colors.js';
import { bar, dimensionBars, pct, renderResultCharts, signed, sparkline, upliftGauge } from './charts.js';

export type LastResult =
  | { kind: 'score' | 'skill'; result: RunResult }
  | { kind: 'history'; entries: HistoryEntry[] }
  | { kind: 'doctor' | 'inventory'; text: string }
  | null;

const fmt = (x: number | null): string => (x === null ? 'n/a' : x.toFixed(2));

/** A compact, LLM-friendly summary of the last result (plain text, no color). */
export function resultDigest(last: LastResult): string | null {
  if (!last) return null;

  if (last.kind === 'score' || last.kind === 'skill') {
    const r = last.result;
    const h = r.headline;
    const subject = r.meta.subject?.kind === 'skill' ? `skill "${r.meta.subject.name}"` : 'codebase';
    const lines: string[] = [
      `  Last command: ${last.kind} (${subject}); spec source: ${r.meta.specSource}`,
      `  uplift ${signed(h.uplift.estimate)} (95% CI ${signed(h.uplift.lo)}…${signed(h.uplift.hi)}); ` +
        `gate ${pct(h.gate.threshold)} → ${h.gate.pass ? 'PASS' : 'FAIL'} (needs CI lower bound ≥ gate)`,
      `  win rate ${pct(h.winRate.estimate)} over ${r.outcomes.length} head-to-head comparisons`,
      '  dimensions (your code vs zero-shot rebuild):',
    ];
    for (const d of r.dimensions) {
      lines.push(
        d.repoScore === null && d.baselineScore === null
          ? `  - ${d.dimension}: not measured (scanner unavailable)`
          : `  - ${d.dimension}: code ${fmt(d.repoScore)} vs zero-shot ${fmt(d.baselineScore)} ` +
              `(uplift ${signed(d.uplift)}, weight ${pct(d.weight)})`,
      );
    }
    if (r.meta.warnings.length) lines.push(`  caveats: ${r.meta.warnings.join('; ')}`);
    return lines.join('\n');
  }

  if (last.kind === 'history') {
    const e = last.entries;
    if (e.length === 0) return '  Last command: history — no runs recorded yet.';
    const latest = e[e.length - 1]!;
    const first = e[0]!;
    return [
      `  Last command: history — ${e.length} run(s), baseline model ${latest.baselineModel}`,
      `  latest uplift ${signed(latest.uplift)} (${latest.gatePass ? 'passes' : 'below'} the gate)`,
      `  change: ${signed(latest.uplift - (e[e.length - 2]?.uplift ?? latest.uplift))} vs previous, ` +
        `${signed(latest.uplift - first.uplift)} vs first`,
      `  series (oldest→newest): ${e.map((x) => signed(x.uplift)).join(', ')}`,
    ].join('\n');
  }

  if (last.kind === 'doctor' || last.kind === 'inventory') {
    // plain text output, trimmed.
    const text = last.text.length > 1600 ? last.text.slice(0, 1600) + ' …(truncated)' : last.text;
    return `  Last command: ${last.kind}\n${text}`;
  }

  return null;
}

/** Which charts can be drawn from this result right now. */
export function availableCharts(last: LastResult): string[] {
  if (!last) return [];
  if (last.kind === 'score' || last.kind === 'skill') return ['result', 'dimensions', 'uplift', 'winrate'];
  if (last.kind === 'history') return ['history'];
  return [];
}

/** Draw a named chart from the last result, or null if it can't be drawn. */
export function drawChart(last: LastResult, name: string): string | null {
  if (!last) return null;

  if (last.kind === 'score' || last.kind === 'skill') {
    const r = last.result;
    const h = r.headline;
    switch (name) {
      case 'result':
        return renderResultCharts(r);
      case 'dimensions':
        return '\n' + c.bold('  Per-dimension: your code vs. zero-shot') + '\n\n' + dimensionBars(r);
      case 'uplift':
        return (
          '\n  ' +
          c.bold('Uplift vs. the gate') +
          '\n' +
          upliftGauge(h.uplift.estimate, h.uplift.lo, h.uplift.hi, h.gate.threshold, { pass: h.gate.pass })
        );
      case 'winrate':
        return (
          '\n  ' +
          c.bold('Win rate') +
          c.dim(' (head-to-head, ties = ½)') +
          '\n    ' +
          c.green(bar(h.winRate.estimate, 22)) +
          ` ${pct(h.winRate.estimate)}  ` +
          c.dim(`n=${r.outcomes.length}`)
        );
      default:
        return null;
    }
  }

  if (last.kind === 'history' && name === 'history') {
    const e = last.entries;
    if (e.length === 0) return null;
    const spark = sparkline(e.map((x) => x.uplift));
    const range = `${signed(Math.min(...e.map((x) => x.uplift)))} … ${signed(Math.max(...e.map((x) => x.uplift)))}`;
    return `\n  ${c.bold('Uplift trend')}  ${c.cyan(spark)}  ${c.dim(`(${e.length} runs, range ${range})`)}`;
  }

  return null;
}
