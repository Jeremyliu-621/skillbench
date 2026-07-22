import type { RunResult } from '../types.js';
import type { TrendSummary } from '../history.js';

/** Terminal summary of a run. Kept dependency-free (no color libs). */
export function renderConsoleSummary(result: RunResult, trend?: TrendSummary | null): string {
  const { headline, dimensions, meta } = result;
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  const isSkill = meta.subject?.kind === 'skill';
  const unit = isSkill ? 'tasks' : 'modules';

  lines.push('');
  lines.push('═'.repeat(60));
  lines.push(`  2bench — ${isSkill ? 'skill vs. plain prompting' : 'codebase vs. pure-LLM baseline'}`);
  if (isSkill) lines.push(`  ${meta.subject!.name}`);
  lines.push('═'.repeat(60));

  const hasUplift = result.outcomes.length > 0 || dimensions.some((d) => d.inUplift);
  if (!hasUplift) {
    lines.push('  Mode: repo-health only (no baseline comparison available).');
    lines.push('  Run without --offline, or with cached baseline artifacts, for uplift.');
  } else if (isSkill) {
    lines.push(`  Win rate:  ${pct(headline.winRate.estimate)}  ` +
      `(95% CI ${pct(headline.winRate.lo)}–${pct(headline.winRate.hi)}, n=${result.outcomes.length})`);
    lines.push(`  Uplift:    ${signed(headline.uplift.estimate)}  ` +
      `(95% CI ${signed(headline.uplift.lo)}–${signed(headline.uplift.hi)})`);
    lines.push(
      `  Verdict:   ${headline.gate.pass ? 'EARNS ITS KEEP' : 'DOES NOT CLEAR THE BAR'}  ` +
        `(needs CI lower bound ≥ ${pct(headline.gate.threshold)}; lower bound = ${signed(headline.uplift.lo)})`,
    );
  } else {
    lines.push(`  Win rate:  ${pct(headline.winRate.estimate)}  ` +
      `(95% CI ${pct(headline.winRate.lo)}–${pct(headline.winRate.hi)}, n=${result.outcomes.length})`);
    lines.push(`  Uplift:    ${signed(headline.uplift.estimate)}  ` +
      `(95% CI ${signed(headline.uplift.lo)}–${signed(headline.uplift.hi)})`);
    lines.push(
      `  Gate:      ${headline.gate.pass ? 'PASS' : 'FAIL'}  ` +
        `(needs CI lower bound ≥ ${pct(headline.gate.threshold)}; lower bound = ${signed(headline.uplift.lo)})`,
    );
  }

  lines.push('─'.repeat(60));
  lines.push(
    isSkill
      ? '  Dimension        skill   plain      uplift   tasks'
      : '  Dimension        repo    baseline   uplift   modules',
  );
  for (const d of dimensions) {
    const measured = d.inUplift;
    lines.push(
      `  ${d.dimension.padEnd(15)} ` +
        `${cell(d.repoScore)}  ${cell(d.baselineScore)}   ` +
        `${measured ? signed(d.uplift).padStart(7) : '   n/a '}   ${String(d.modulesMeasured).padStart(2)}`,
    );
  }

  if (trend && trend.deltaFromPrevious !== null) {
    const arrow = trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '→';
    lines.push('─'.repeat(60));
    lines.push(
      `  Trend:     ${arrow} ${signed(trend.deltaFromPrevious)} vs previous run ` +
        `(${trend.runs} runs recorded)`,
    );
    if (trend.baselineChanged) {
      lines.push('             ⚠ baseline model changed — reflects LLM capability, not just your pipeline');
    }
  }

  if (meta.warnings.length > 0) {
    lines.push('─'.repeat(60));
    lines.push('  Measurement caveats:');
    for (const w of meta.warnings) lines.push(`  ⚠ ${wrap(w, 56, '    ')}`);
  }

  lines.push('─'.repeat(60));
  lines.push(
    `  Sampled ${meta.modulesSampled}/${meta.modulesTotal} ${unit}` +
      (isSkill ? '' : ` · specs: ${meta.specSource}`) +
      ` · seed ${meta.seed}`,
  );
  lines.push(
    isSkill
      ? `  Model: ${meta.baselineModel} · ${meta.samplesPerSpec} samples per arm`
      : `  Baseline: ${meta.baselineModel} · ${meta.samplesPerSpec} samples/spec`,
  );
  lines.push('═'.repeat(60));
  return lines.join('\n');
}

function signed(x: number): string {
  return `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
}

/** Soft-wrap long caveat text so the terminal box stays readable. */
function wrap(text: string, width: number, indent: string): string {
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line.length + word.length + 1 > width) {
      out.push(line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) out.push(line);
  return out.join(`\n${indent}`);
}

function cell(x: number | null): string {
  return x === null || Number.isNaN(x) ? '  n/a ' : `${(x * 100).toFixed(1)}%`.padStart(6);
}
