/**
 * The command layer: what `doctor`/`inventory`/`score`/... actually do, with no
 * assumptions about *how* they were invoked.
 *
 * Two front-ends call these: the flag-driven CLI (`cli.ts`) and the interactive
 * agent (`repl.ts`). Keeping the bodies here means the two can never disagree
 * about what a command does, and the REPL gets scoring for free.
 *
 * The cheap, deterministic commands return a ready-to-print string. The costly
 * ones (score/skill) return the RunResult too, so the caller can set an exit
 * code (CI) or keep chatting (REPL).
 */
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import type { BenchConfig, RunResult } from './types.js';
import { loadConfig } from './config.js';
import { codexVersion } from './engine/codex.js';
import { inventory, sampleModules } from './stages/inventory.js';
import { detectTools } from './stages/deterministic.js';
import { runPipeline } from './pipeline.js';
import { loadBench, runSkillBench } from './skill-pipeline.js';
import { writeJsonReport } from './report/json-report.js';
import { renderConsoleSummary } from './report/console-report.js';
import { renderHtmlReport } from './report/html-report.js';
import { appendHistory, readHistory, summarizeTrend } from './history.js';

export async function doctorReport(): Promise<string> {
  const codex = await codexVersion();
  const lines: string[] = [];
  lines.push(`codex CLI     ${codex ? `OK (${codex})` : 'MISSING — install: npm i -g @openai/codex'}`);
  lines.push(`node          OK (${process.version})`);
  lines.push('complexity    OK (built-in, TS compiler API — always available)');
  for (const tool of await detectTools()) {
    const status = tool.found
      ? `OK (${tool.version ?? '?'})`
      : tool.required
        ? 'MISSING (required)'
        : `missing — ${tool.dimension} sub-score will be skipped`;
    lines.push(`${tool.name.padEnd(14)}${status}`);
  }
  lines.push(
    '\nOptional scanners install with:\n' +
      '  npm i -g jscpd eslint            # duplication, lint (npx-resolvable)\n' +
      '  pipx install semgrep             # security (OWASP/CWE)\n' +
      '  https://github.com/gitleaks/gitleaks/releases   # secret detection',
  );
  return lines.join('\n');
}

export async function inventoryReport(
  repo: string,
  opts: { sample?: number; seed?: number; config?: BenchConfig } = {},
): Promise<string> {
  const config = opts.config ?? (await loadConfig());
  const inv = await inventory(resolve(repo));
  const size =
    opts.sample ??
    Math.min(config.sampling.maxModules, Math.max(config.sampling.minModules, Math.round(inv.modules.length / 4)));
  const seed = opts.seed ?? config.sampling.seed;
  const sampled = sampleModules(inv.modules, { size, seed });
  const sampledIds = new Set(sampled.map((m) => m.id));

  const lines: string[] = [];
  lines.push(`\nRepo: ${inv.repoRoot}`);
  lines.push(`Modules: ${inv.modules.length}   Total LOC: ${inv.totalLoc}\n`);
  for (const m of inv.modules) {
    const mark = sampledIds.has(m.id) ? '●' : ' ';
    lines.push(`  ${mark} ${m.id.padEnd(48)} ${String(m.loc).padStart(6)} loc  ${m.kind.padEnd(7)} [${m.subsystem}]`);
  }
  lines.push(`\n● = in evaluation sample (${sampled.length} modules, seed ${seed})`);
  return lines.join('\n');
}

export async function historyReport(dir: string): Promise<string> {
  const entries = await readHistory(resolve(dir));
  if (entries.length === 0) {
    return 'No runs recorded yet. Run `score <repo>` first.';
  }
  const pct = (x: number) => `${x >= 0 ? '+' : '−'}${Math.abs(x * 100).toFixed(1)}%`;
  const lines: string[] = [];
  lines.push('\n  Run         Uplift    95% CI               Win     Mods  Baseline model     Gate');
  lines.push('  ' + '─'.repeat(84));
  for (const e of entries) {
    lines.push(
      `  ${e.at.slice(0, 10)}  ${pct(e.uplift).padStart(7)}   ` +
        `${(pct(e.upliftLo) + ' … ' + pct(e.upliftHi)).padEnd(20)} ` +
        `${(e.winRate * 100).toFixed(0).padStart(3)}%   ${String(e.modulesSampled).padStart(4)}  ` +
        `${e.baselineModel.padEnd(18)} ${e.gatePass ? 'pass' : 'below'}`,
    );
  }
  const trend = summarizeTrend(entries)!;
  lines.push('  ' + '─'.repeat(84));
  if (trend.deltaFromPrevious !== null) {
    const arrow = trend.direction === 'up' ? '▲' : trend.direction === 'down' ? '▼' : '→';
    lines.push(`  ${arrow} ${pct(trend.deltaFromPrevious)} since the previous run · ${pct(trend.deltaFromFirst)} since the first`);
    if (trend.baselineChanged) {
      lines.push('  ⚠ the baseline model changed between the last two runs — a move here reflects');
      lines.push('    the vanilla LLM getting better or worse, not necessarily your pipeline.');
    }
  }
  return lines.join('\n');
}

export interface ScoreOptions {
  config?: string;
  out?: string;
  offline?: boolean;
  seed?: number;
  sample?: number;
  specs?: string;
  onProgress?: (m: string) => void;
}

export interface RunOutcome {
  result: RunResult;
  summary: string;
  jsonPath: string;
  htmlPath: string;
}

export async function scoreRepo(repo: string, opts: ScoreOptions = {}): Promise<RunOutcome> {
  const config = await loadConfig(opts.config);
  const outDir = resolve(opts.out ?? '.2bench');
  const result = await runPipeline(resolve(repo), config, {
    outDir,
    offline: opts.offline ?? false,
    seed: opts.seed,
    sampleSize: opts.sample,
    specsDir: opts.specs ? resolve(opts.specs) : undefined,
    onProgress: opts.onProgress,
  });
  return finishRun(result, outDir);
}

export interface SkillOptions {
  config?: string;
  out?: string;
  onProgress?: (m: string) => void;
}

export async function benchSkill(benchPath: string, opts: SkillOptions = {}): Promise<RunOutcome> {
  const config = await loadConfig(opts.config);
  const outDir = resolve(opts.out ?? '.2bench-skill');
  const loaded = await loadBench(resolve(benchPath));
  const result = await runSkillBench(loaded.bench, loaded.skill, config, {
    outDir,
    onProgress: opts.onProgress,
  });
  return finishRun(result, outDir);
}

/** Shared tail: persist score.json + report.html, append history, render summary. */
async function finishRun(result: RunResult, outDir: string): Promise<RunOutcome> {
  const jsonPath = resolve(outDir, 'score.json');
  const htmlPath = resolve(outDir, 'report.html');
  await writeJsonReport(result, jsonPath);
  // Append first so this run appears in its own report's trend.
  await appendHistory(outDir, result);
  const history = await readHistory(outDir);
  await writeFile(htmlPath, renderHtmlReport(result, history), 'utf8');
  const summary = renderConsoleSummary(result, summarizeTrend(history));
  return { result, summary, jsonPath, htmlPath };
}
