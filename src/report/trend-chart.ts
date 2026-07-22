import type { HistoryEntry } from '../history.js';

/**
 * Uplift-over-time chart for the report.
 *
 * Form: change-over-time of ONE measure → a line with points. One series, so no
 * legend (the heading names it) and no color-coded categories. Uplift can be
 * negative, so the y-domain always contains zero and a zero rule is drawn; the
 * gate threshold is a dashed reference rule, not a series.
 *
 * Marks follow the house spec: 2px line, 8px markers, recessive axes, and a
 * direct label on the latest point only (never a number on every point). Hover
 * detail rides on SVG <title>, which keeps the report script-free — the file has
 * to stay self-contained and safe to hand a client.
 *
 * Colors are the report's accent, validated for both modes against the chart
 * lightness band (light #2e5aac, dark #6389ee).
 */

const W = 640;
const H = 190;
const PAD = { top: 18, right: 56, bottom: 30, left: 46 };

export function renderTrendChart(entries: readonly HistoryEntry[]): string {
  if (entries.length < 2) return '';

  const threshold = entries[entries.length - 1]!.gateThreshold;
  const values = entries.map((e) => e.uplift);
  const domain = niceDomain([...values, 0, threshold]);

  const plotW = W - PAD.left - PAD.right;
  const plotH = H - PAD.top - PAD.bottom;
  const x = (i: number) =>
    PAD.left + (entries.length === 1 ? plotW / 2 : (i / (entries.length - 1)) * plotW);
  const y = (v: number) =>
    PAD.top + plotH - ((v - domain.min) / (domain.max - domain.min)) * plotH;

  const linePath = entries.map((e, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(e.uplift).toFixed(1)}`).join(' ');
  const last = entries[entries.length - 1]!;

  const gridLines = domain.ticks
    .map(
      (t) =>
        `<line class="grid" x1="${PAD.left}" y1="${y(t).toFixed(1)}" x2="${W - PAD.right}" y2="${y(t).toFixed(1)}"/>` +
        `<text class="axis" x="${PAD.left - 8}" y="${(y(t) + 4).toFixed(1)}" text-anchor="end">${fmtPct(t)}</text>`,
    )
    .join('');

  const points = entries
    .map(
      (e, i) =>
        `<g class="pt"><circle cx="${x(i).toFixed(1)}" cy="${y(e.uplift).toFixed(1)}" r="4"/>` +
        `<title>${escapeXml(shortDate(e.at))} · uplift ${fmtPct(e.uplift)} (CI ${fmtPct(e.upliftLo)}–${fmtPct(e.upliftHi)}) · ${e.modulesSampled} modules · baseline ${escapeXml(e.baselineModel)}</title></g>`,
    )
    .join('');

  const xLabels = entries
    .map((e, i) =>
      i === 0 || i === entries.length - 1
        ? `<text class="axis" x="${x(i).toFixed(1)}" y="${H - 8}" text-anchor="${i === 0 ? 'start' : 'end'}">${escapeXml(shortDate(e.at))}</text>`
        : '',
    )
    .join('');

  return `<section class="trend">
    <h2>Uplift over time</h2>
    <p class="lead">The pure-LLM baseline is a moving target — as frontier models improve, holding this number steady means the custom pipeline improved too. Hover any point for that run's detail.</p>
    <div class="chart-wrap">
      <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Uplift over ${entries.length} runs, latest ${fmtPct(last.uplift)}" preserveAspectRatio="xMidYMid meet">
        ${gridLines}
        <line class="zero" x1="${PAD.left}" y1="${y(0).toFixed(1)}" x2="${W - PAD.right}" y2="${y(0).toFixed(1)}"/>
        <line class="threshold" x1="${PAD.left}" y1="${y(threshold).toFixed(1)}" x2="${W - PAD.right}" y2="${y(threshold).toFixed(1)}"/>
        <text class="threshold-label" x="${W - PAD.right + 6}" y="${(y(threshold) + 4).toFixed(1)}">gate ${fmtPct(threshold)}</text>
        <path class="series" d="${linePath}"/>
        ${points}
        <text class="value-label" x="${(x(entries.length - 1) + 8).toFixed(1)}" y="${(y(last.uplift) - 8).toFixed(1)}">${fmtPct(last.uplift)}</text>
        ${xLabels}
      </svg>
    </div>
    ${renderTable(entries)}
  </section>`;
}

/** Table view — the non-visual path to the same data (accessibility requirement). */
function renderTable(entries: readonly HistoryEntry[]): string {
  const rows = [...entries]
    .reverse()
    .map(
      (e) =>
        `<tr><td>${escapeXml(shortDate(e.at))}</td><td class="num">${fmtPct(e.uplift)}</td>` +
        `<td class="num">${fmtPct(e.upliftLo)} – ${fmtPct(e.upliftHi)}</td>` +
        `<td class="num">${fmtPct(e.winRate)}</td><td class="num">${e.modulesSampled}</td>` +
        `<td>${escapeXml(e.baselineModel)}</td><td>${e.gatePass ? 'pass' : 'below'}</td></tr>`,
    )
    .join('');
  return `<details class="trend-table"><summary>All runs (${entries.length})</summary>
    <div class="table-scroll"><table>
      <thead><tr><th>Run</th><th>Uplift</th><th>95% CI</th><th>Win rate</th><th>Modules</th><th>Baseline model</th><th>Gate</th></tr></thead>
      <tbody>${rows}</tbody>
    </table></div></details>`;
}

/** Domain padded to round percentage steps, always containing zero. */
export function niceDomain(values: readonly number[]): { min: number; max: number; ticks: number[] } {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const step = 0.25;
  const min = Math.floor(lo / step) * step;
  const max = Math.ceil(hi / step) * step;
  const span = max - min || step;
  const ticks: number[] = [];
  for (let t = min; t <= max + 1e-9; t += span / 4) ticks.push(round(t));
  return { min, max: min + span, ticks };
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function fmtPct(x: number): string {
  return `${x >= 0 ? '+' : '−'}${Math.abs(Math.round(x * 100))}%`;
}

function shortDate(iso: string): string {
  const d = iso.slice(0, 10);
  return d.length === 10 ? d.slice(5) : iso.slice(0, 10);
}

function escapeXml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

export const TREND_STYLE = `
.trend{margin:28px 0}
.chart-wrap{overflow-x:auto;margin-top:8px}
.trend svg{width:100%;min-width:420px;height:auto;display:block}
.trend .grid{stroke:var(--hairline);stroke-width:1}
.trend .zero{stroke:var(--muted);stroke-width:1;opacity:.6}
.trend .threshold{stroke:var(--warn);stroke-width:1.5;stroke-dasharray:5 4;opacity:.9}
.trend .threshold-label{fill:var(--warn);font-size:10px;font-family:var(--mono)}
.trend .series{fill:none;stroke:var(--chart);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}
.trend .pt circle{fill:var(--chart);stroke:var(--surface);stroke-width:2}
.trend .pt:hover circle{r:5.5}
.trend .axis{fill:var(--muted);font-size:10px;font-family:var(--mono)}
.trend .value-label{fill:var(--ink);font-size:12px;font-weight:600;font-family:var(--mono);text-anchor:end}
.trend-table{margin-top:12px}
.trend-table summary{cursor:pointer;font-size:.85rem;color:var(--muted)}
.trend-table summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.table-scroll{overflow-x:auto;margin-top:8px}
.trend-table table{border-collapse:collapse;width:100%;font-size:.8rem}
.trend-table th{text-align:left;font-weight:600;color:var(--muted);border-bottom:1px solid var(--hairline);padding:6px 10px 6px 0}
.trend-table td{padding:6px 10px 6px 0;border-bottom:1px solid var(--hairline)}
.trend-table .num{font-family:var(--mono);font-variant-numeric:tabular-nums}
`;
