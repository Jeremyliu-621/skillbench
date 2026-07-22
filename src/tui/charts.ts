/**
 * Terminal charts — real graphs drawn in the chat, from real result data.
 *
 * All pure string builders (no I/O, no color state of their own beyond the
 * shared `c`), so they unit-test cleanly: in a non-TTY test run `c.*` is a
 * no-op, so assertions see the raw block/braille characters.
 */
import type { RunResult } from '../types.js';
import { c } from './colors.js';

const clamp01 = (x: number): number => (x < 0 ? 0 : x > 1 ? 1 : x);
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

export const pct = (x: number): string => `${Math.round(x * 100)}%`;
export const signed = (x: number): string => `${x >= 0 ? '+' : '−'}${Math.round(Math.abs(x) * 100)}%`;

/** A horizontal bar of exactly `width` visible columns for a value in [0,1]. */
export function bar(value01: number | null, width: number, trackChar = '░'): string {
  const v = clamp01(value01 ?? 0);
  const eighths = Math.round(v * width * 8);
  const full = Math.min(Math.floor(eighths / 8), width);
  const rem = eighths % 8;
  let out = '█'.repeat(full);
  let used = full;
  if (full < width && rem > 0) {
    out += EIGHTHS[rem];
    used += 1;
  }
  return out + trackChar.repeat(Math.max(0, width - used));
}

/** A compact inline sparkline for a series (history trend). */
export function sparkline(values: number[]): string {
  if (values.length === 0) return '';
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  return values.map((v) => SPARK[Math.round(((v - min) / span) * (SPARK.length - 1))]).join('');
}

const fmtScore = (x: number | null): string => (x === null ? c.dim(' n/a') : x.toFixed(2));

/** Per-dimension: two stacked bars (your code vs the zero-shot rebuild) + the delta. */
export function dimensionBars(result: RunResult): string {
  const W = 22;
  const lines: string[] = [];
  for (const d of result.dimensions) {
    const cap = d.dimension[0]!.toUpperCase() + d.dimension.slice(1);
    const head = `  ${c.bold(cap)}${c.dim(`  ·  weight ${pct(d.weight)}`)}`;
    if (d.repoScore === null && d.baselineScore === null) {
      lines.push(head, `    ${c.yellow('not measured')} ${c.dim('— scanner unavailable (see /doctor)')}`, '');
      continue;
    }
    let delta = '';
    if (d.repoScore !== null && d.baselineScore !== null) {
      delta =
        d.uplift > 0.01
          ? '   ' + c.green(`▲ ${signed(d.uplift)}`)
          : d.uplift < -0.01
            ? '   ' + c.red(`▼ ${signed(d.uplift)}`)
            : '   ' + c.dim('→ even');
    }
    lines.push(
      head,
      `    ${c.dim('code'.padEnd(9))} ${c.green(bar(d.repoScore, W))} ${fmtScore(d.repoScore)}`,
      `    ${c.dim('zero-shot'.padEnd(9))} ${c.brandDim(bar(d.baselineScore, W))} ${fmtScore(d.baselineScore)}${delta}`,
      '',
    );
  }
  return lines.join('\n');
}

/**
 * The money graph: uplift with its confidence band, the estimate marker, and the
 * pass/fail gate line, all on one axis.
 *
 *   [────════●════════┃──────────]
 *   estimate +23%   95% CI −7%…+56%   gate 40%   ✗ below
 */
export function upliftGauge(
  estimate: number,
  lo: number,
  hi: number,
  threshold: number,
  opts: { width?: number; pass?: boolean } = {},
): string {
  const W = opts.width ?? 44;
  const rawMin = Math.min(0, lo, estimate);
  const rawMax = Math.max(hi, threshold, estimate);
  const padAmt = (rawMax - rawMin || 1) * 0.08;
  const dMin = rawMin - padAmt;
  const dMax = rawMax + padAmt;
  const at = (v: number): number => Math.max(0, Math.min(W - 1, Math.round(((v - dMin) / (dMax - dMin)) * (W - 1))));

  const cells = Array.from({ length: W }, () => '─');
  cells[at(0)] = '┼'; // zero reference
  const a = at(lo);
  const b = at(hi);
  for (let i = Math.min(a, b); i <= Math.max(a, b); i++) cells[i] = '═'; // CI band
  cells[at(threshold)] = '┃'; // the gate
  cells[at(estimate)] = '●'; // the point estimate

  const pass = opts.pass ?? estimate >= threshold;
  const painted = cells
    .map((ch) =>
      ch === '●' ? (pass ? c.green(ch) : c.red(ch)) : ch === '┃' ? c.yellow(ch) : ch === '═' ? c.cyan(ch) : c.dim(ch),
    )
    .join('');

  const verdict = pass ? c.green('✔ clears the gate') : c.red('✗ below the gate');
  const legend =
    `  ${c.dim('estimate')} ${c.bold(signed(estimate))}   ` +
    `${c.dim(`95% CI ${signed(lo)}…${signed(hi)}`)}   ` +
    `${c.dim('gate')} ${c.yellow(pct(threshold))}   ${verdict}`;

  return `  ${painted}\n${legend}`;
}

/** Full result view: headline, win-rate bar, per-dimension bars, uplift gauge. */
export function renderResultCharts(result: RunResult): string {
  const isSkill = result.meta.subject?.kind === 'skill';
  const subject = isSkill ? `skill: ${result.meta.subject!.name}` : 'codebase vs. zero-shot baseline';
  const { winRate, uplift, gate } = result.headline;

  const out: string[] = [];
  out.push('', c.bold('  ── Result ' + '─'.repeat(46)), c.dim(`  ${subject}`), '');

  if (result.outcomes.length > 0) {
    out.push(`  ${c.bold('Win rate')} ${c.dim('(head-to-head, ties = ½)')}`);
    out.push(`    ${c.green(bar(winRate.estimate, 22))} ${pct(winRate.estimate)}  ${c.dim(`n=${result.outcomes.length}`)}`, '');
  }

  out.push(dimensionBars(result));

  out.push(c.bold('  Uplift') + c.dim('  (weighted; gate = CI lower bound must clear the bar)'));
  out.push(upliftGauge(uplift.estimate, uplift.lo, uplift.hi, gate.threshold, { pass: gate.pass }));

  return out.join('\n');
}
