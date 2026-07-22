#!/usr/bin/env node
import { Command } from 'commander';
import { resolve } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { doctorReport, inventoryReport, historyReport, scoreRepo, benchSkill, linearPull } from './commands.js';
import { exitCodeFor } from './report/json-report.js';
import { discoverHistories } from './history.js';
import { renderDashboard } from './report/dashboard.js';
import { serveDashboard } from './serve.js';
import { runProcess } from './engine/proc.js';
import { startRepl } from './repl.js';

const program = new Command();

program
  .name('2bench')
  .description(
    'Scores a codebase against a pure-LLM baseline: how much better is it than what a zero-shot LLM would have produced?',
  )
  .version('0.1.0');

// Bare `2bench` (no subcommand) launches the friendly interactive agent.
program
  .command('chat', { isDefault: true })
  .description('Start the interactive agent — a banner, the command list, then chat (default with no command)')
  .action(async () => {
    await startRepl();
  });

program
  .command('inventory')
  .description('Walk a repo, list its modules, and show which would be sampled for evaluation')
  .argument('<repo>', 'path to the repository to inventory')
  .option('--sample <n>', 'sample size to preview', (v) => parseInt(v, 10))
  .option('--seed <n>', 'sampling seed', (v) => parseInt(v, 10))
  .action(async (repo: string, opts: { sample?: number; seed?: number }) => {
    console.log(await inventoryReport(repo, { sample: opts.sample, seed: opts.seed }));
  });

program
  .command('doctor')
  .description('Check that the engines and scanners 2bench depends on are available')
  .action(async () => {
    console.log(await doctorReport());
  });

program
  .command('score')
  .description('Run the evaluation pipeline and produce score.json (+ report.html)')
  .argument('<repo>', 'path to the repository to score')
  .option('--config <path>', 'path to a 2bench config file')
  .option('--out <dir>', 'output directory', '.2bench')
  .option('--offline', 'make zero Codex calls (reuse cached artifacts if present; else repo-health only)', false)
  .option('--seed <n>', 'sampling/bootstrap seed', (v) => parseInt(v, 10))
  .option('--sample <n>', 'number of modules to sample', (v) => parseInt(v, 10))
  .option('--specs <dir>', 'directory of externally-authored specs (<module-key>.json, e.g. src__services__tax.json) — the honest apples-to-apples mode')
  .action(async (repo: string, opts: { config?: string; out: string; offline: boolean; seed?: number; sample?: number; specs?: string }) => {
    const { result, summary, jsonPath, htmlPath } = await scoreRepo(repo, {
      config: opts.config,
      out: opts.out,
      offline: opts.offline,
      seed: opts.seed,
      sample: opts.sample,
      specs: opts.specs,
      onProgress: (m) => console.error(`  ${m}`),
    });
    console.log(summary);
    console.log(`\nWrote ${jsonPath}\nWrote ${htmlPath}`);
    process.exitCode = exitCodeFor(result);
  });

program
  .command('skill')
  .description('Score a skill against plain prompting on the same tasks (does the skill earn its keep?)')
  .argument('<bench>', 'path to a bench file (JSON: name, skill/skillFile, tasks[])')
  .option('--config <path>', 'path to a 2bench config file')
  .option('--out <dir>', 'output directory', '.2bench-skill')
  .action(async (bench: string, opts: { config?: string; out: string }) => {
    const { result, summary, jsonPath, htmlPath } = await benchSkill(bench, {
      config: opts.config,
      out: opts.out,
      onProgress: (m) => console.error(`  ${m}`),
    });
    console.log(summary);
    console.log(`\nWrote ${jsonPath}\nWrote ${htmlPath}`);
    process.exitCode = exitCodeFor(result);
  });

program
  .command('linear')
  .description('Pull real Linear tickets into a --specs directory (the gold-standard, circularity-free spec source)')
  .option('--specs <dir>', 'output directory for spec JSONs', 'specs')
  .option('--team <key>', 'Linear team key, e.g. ERP')
  .option('--project <name>', 'Linear project name')
  .option('--label <name>', 'only issues carrying this label')
  .option('--since <iso>', 'only issues updated since (ISO timestamp), or "auto" to resume the last sync')
  .option('--map <file>', 'JSON file mapping a label or project name → module path')
  .option('--label-prefix <p>', 'label convention prefix for per-issue mapping', 'spec:')
  .action(async (opts: { specs: string; team?: string; project?: string; label?: string; since?: string; map?: string; labelPrefix?: string }) => {
    try {
      const { summary } = await linearPull({ ...opts, onProgress: (m) => console.error(`  ${m}`) });
      console.log(summary);
    } catch (err) {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 2;
    }
  });

program
  .command('history')
  .description('Show how uplift has moved across runs (the baseline is a moving target)')
  .option('--out <dir>', 'output directory holding history.jsonl', '.2bench')
  .action(async (opts: { out: string }) => {
    console.log(await historyReport(opts.out));
    console.log('');
  });

program
  .command('dashboard')
  .description('Build a portfolio page across every tracked codebase and skill (read-only, from result files)')
  .argument('[dirs...]', 'directories holding history.jsonl (or parents of them)', ['.2bench'])
  .option('--out <file>', 'output HTML file', 'dashboard.html')
  .action(async (dirs: string[], opts: { out: string }) => {
    const subjects = await discoverHistories(dirs.map((d) => resolve(d)));
    const html = renderDashboard({ subjects, generatedAt: new Date().toISOString() });
    const outPath = resolve(opts.out);
    await writeFile(outPath, html, 'utf8');
    if (subjects.length === 0) {
      console.log(`No history.jsonl found under: ${dirs.join(', ')}`);
      console.log('Run `2bench score <repo>` or `2bench skill <bench>` first.');
    } else {
      console.log(`Tracked ${subjects.length} subject${subjects.length === 1 ? '' : 's'}:`);
      for (const s of subjects) {
        const latest = s.entries[s.entries.length - 1]!;
        console.log(`  ${latest.subjectName.padEnd(34)} ${s.entries.length} run(s)  latest ${(latest.uplift * 100).toFixed(1)}%`);
      }
    }
    console.log(`\nWrote ${outPath}`);
  });

program
  .command('serve')
  .description('Serve the portfolio dashboard on localhost (loopback only; re-reads results on each request)')
  .argument('[dirs...]', 'directories holding history.jsonl (or parents of them)', ['.2bench'])
  .option('--port <n>', 'port to listen on', (v) => parseInt(v, 10), 4173)
  .option('--open', 'open the dashboard in your browser', false)
  .action(async (dirs: string[], opts: { port: number; open: boolean }) => {
    const resolved = dirs.map((d) => resolve(d));
    const subjects = await discoverHistories(resolved);
    const handle = await serveDashboard({ dirs: resolved, port: opts.port });

    console.log(`\n  2bench portfolio → ${handle.url}`);
    console.log(`  ${subjects.length} subject${subjects.length === 1 ? '' : 's'} from: ${dirs.join(', ')}`);
    if (subjects.length === 0) {
      console.log('  (no results yet — run `2bench score <repo>` or `2bench skill <bench>`)');
    }
    console.log('  Loopback only — nothing is exposed to the network. Ctrl+C to stop.\n');

    if (opts.open) {
      const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
      runProcess(cmd, [handle.url], { timeoutMs: 10_000 }).catch(() => {});
    }
  });

program.parseAsync().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 2;
});
