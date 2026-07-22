/**
 * The interactive agent — the friendly, graphical front door.
 *
 * `2bench` with no arguments lands here: a block-letter banner, the command
 * list, and a chat prompt. You can drive it precisely with slash-commands
 * (`/score .`) or just talk to it. Results are drawn as real charts (dimension
 * bars, an uplift gauge, history sparklines), and you can ask the agent to
 * "explain that" — it explains the last result in plain words and, when a
 * picture helps, the app draws the matching chart from the real data.
 *
 * Design held from before: explicit slash-commands run as typed; the agent's
 * proposals always pass a confirm gate, so a chat turn can't kick off an
 * expensive scoring run on its own.
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';
import { COMMANDS } from './agent/catalog.js';
import {
  askConcierge,
  ConciergeError,
  type ConciergeContext,
  type ConciergeEngine,
  type ConciergeReply,
  type ConciergeTurn,
} from './agent/concierge.js';
import { doctorReport, inventoryReport, historyReport, scoreRepo, benchSkill } from './commands.js';
import { readHistory } from './history.js';
import { serveDashboard, type ServeHandle } from './serve.js';
import { runProcess } from './engine/proc.js';
import { c } from './tui/colors.js';
import { banner } from './tui/banner.js';
import { Spinner } from './tui/spinner.js';
import { renderResultCharts } from './tui/charts.js';
import { availableCharts, drawChart, resultDigest, type LastResult } from './tui/result-context.js';

// ── parsing (pure, unit-tested) ────────────────────────────────────────────

export type ParsedLine =
  | { kind: 'empty' }
  | { kind: 'chat'; text: string }
  | { kind: 'slash'; command: string; args: string[] };

/** Classify a line of REPL input. A leading `/` means a command; anything else
 *  is a message for the concierge. */
export function parseReplLine(line: string): ParsedLine {
  const trimmed = line.trim();
  if (!trimmed) return { kind: 'empty' };
  if (trimmed.startsWith('/')) {
    const tokens = trimmed.slice(1).split(/\s+/).filter(Boolean);
    const command = (tokens.shift() ?? '').toLowerCase();
    return { kind: 'slash', command, args: tokens };
  }
  return { kind: 'chat', text: trimmed };
}

// ── input ──────────────────────────────────────────────────────────────────

/**
 * A line reader that never drops input. `readline/promises` `question()` throws
 * away buffered lines when the stream closes while an async handler is running
 * (fine for interactive TTYs, but it loses lines from piped/scripted input). We
 * queue every 'line' event ourselves, so buffered lines survive close and are
 * returned in order; only once the queue is empty does a closed stream yield
 * null (a clean end-of-session on Ctrl+C / Ctrl+D / EOF).
 */
class LineReader {
  private queue: string[] = [];
  private pending: ((v: string | null) => void) | null = null;
  private closed = false;

  constructor(rl: Interface) {
    rl.on('line', (line: string) => {
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve(line);
      } else {
        this.queue.push(line);
      }
    });
    rl.on('close', () => {
      this.closed = true;
      if (this.pending) {
        const resolve = this.pending;
        this.pending = null;
        resolve(null);
      }
    });
  }

  /** Next line, or null when input is exhausted. Writes `promptStr` only when it
   *  actually has to wait (so buffered/piped lines don't each print a prompt). */
  async next(promptStr: string): Promise<string | null> {
    if (this.queue.length > 0) return this.queue.shift()!;
    if (this.closed) return null;
    stdout.write(promptStr);
    return new Promise<string | null>((resolve) => {
      this.pending = resolve;
    });
  }
}

// ── the command list shown at startup / on /help ───────────────────────────

function commandList(): string {
  const rows = COMMANDS.map((cmd) => {
    const tag = cmd.costly ? c.yellow(' (uses Codex)') : cmd.longLived ? c.dim(' (opens a page)') : '';
    return `  ${c.cyan(('/' + cmd.name).padEnd(11))} ${cmd.summary}${tag}`;
  });
  return [
    c.bold('  Commands'),
    ...rows,
    '',
    '  ' +
      c.dim('Or just talk to me — ask what a command does, or say ') +
      c.cyan('“explain that”') +
      c.dim(' after a run and I’ll break it down, with a chart when it helps.'),
    '  ' + c.cyan('/help') + c.dim('  ·  ') + c.cyan('/quit'),
  ].join('\n');
}

// ── state ──────────────────────────────────────────────────────────────────

interface ReplState {
  history: ConciergeTurn[];
  server: ServeHandle | null;
  last: LastResult;
}

export interface ReplOptions {
  /** Directories the dashboard reads (for `/serve`). Defaults to the two standard out dirs. */
  dirs?: string[];
  /** Injectable concierge engine (tests pass a fake; production uses Codex). */
  conciergeEngine?: ConciergeEngine;
}

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const reader = new LineReader(rl);
  const state: ReplState = { history: [], server: null, last: null };
  const dirs = opts.dirs ?? ['.2bench', '.2bench-skill'];
  const cwd = process.cwd();
  const baseCtx = { cwd, isGitRepo: existsSync(join(cwd, '.git')) };

  stdout.write(banner() + '\n' + commandList() + '\n\n');
  stdout.write(c.dim('  Tip: chatting sends a small request to Codex on your subscription.\n\n'));

  rl.on('SIGINT', () => rl.close());

  while (true) {
    const line = await reader.next(c.green('  2bench ▸ '));
    if (line === null) break; // stream closed (Ctrl+C / Ctrl+D / EOF)
    const parsed = parseReplLine(line);

    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'chat') {
      await handleChat(parsed.text, reader, state, baseCtx, dirs, opts.conciergeEngine);
      continue;
    }
    const done = await handleSlash(parsed.command, parsed.args, reader, state, dirs);
    if (done) break;
  }

  if (state.server) {
    await state.server.close().catch(() => {});
    stdout.write(c.dim('  Dashboard server stopped.\n'));
  }
  rl.close();
  stdout.write('  Bye — run ' + c.cyan('2bench') + ' any time.\n');
}

/** Returns true when the user asked to quit. */
async function handleSlash(
  command: string,
  args: string[],
  reader: LineReader,
  state: ReplState,
  dirs: string[],
): Promise<boolean> {
  switch (command) {
    case 'quit':
    case 'exit':
    case 'q':
      return true;
    case 'help':
    case '?':
      stdout.write('\n' + commandList() + '\n\n');
      return false;
    case 'clear':
      state.history = [];
      state.last = null;
      if (stdout.isTTY) stdout.write('\x1b[2J\x1b[H');
      stdout.write(c.dim('  Fresh start — conversation cleared.\n\n'));
      return false;
    case 'doctor':
      await runText(() => doctorReport(), (text) => (state.last = { kind: 'doctor', text }));
      return false;
    case 'inventory':
      await runText(
        () => inventoryReport(args[0] ?? '.', {}),
        (text) => (state.last = { kind: 'inventory', text }),
      );
      return false;
    case 'history':
      await runHistory(args[0] ?? dirs[0]!, state);
      return false;
    case 'score':
      await runScore(args, reader, state, /* fromAgent */ false);
      return false;
    case 'skill':
      await runSkill(args, reader, state, /* fromAgent */ false);
      return false;
    case 'serve':
      await handleServe(args, state, dirs);
      return false;
    default:
      stdout.write(
        c.yellow(`  Unknown command /${command}.`) + ' Try ' + c.cyan('/help') + ', or just ask me in plain English.\n\n',
      );
      return false;
  }
}

async function handleChat(
  text: string,
  reader: LineReader,
  state: ReplState,
  baseCtx: { cwd: string; isGitRepo: boolean },
  dirs: string[],
  engine?: ConciergeEngine,
): Promise<void> {
  const ctx: ConciergeContext = {
    ...baseCtx,
    resultDigest: resultDigest(state.last),
    availableCharts: availableCharts(state.last),
  };

  const spinner = new Spinner('thinking').start();
  let reply: ConciergeReply;
  try {
    reply = await askConcierge(text, state.history, ctx, engine);
    spinner.clear();
  } catch (err) {
    spinner.clear();
    const why = err instanceof ConciergeError ? err.message : String(err);
    stdout.write(
      c.yellow('  I couldn’t reach Codex just now') +
        c.dim(` (${why}).`) +
        '\n  ' +
        c.dim('Run ') +
        c.cyan('/doctor') +
        c.dim(' to check it, or use a slash-command directly — those don’t need Codex.\n\n'),
    );
    return;
  }

  state.history.push({ role: 'user', content: text });
  state.history.push({ role: 'assistant', content: reply.reply });
  if (state.history.length > 16) state.history.splice(0, state.history.length - 16);

  stdout.write('\n  ' + reply.reply.replace(/\n/g, '\n  ') + '\n');

  // Draw the chart the agent chose — but only from real data we actually have.
  if (reply.chart !== 'none' && availableCharts(state.last).includes(reply.chart)) {
    const drawn = drawChart(state.last, reply.chart);
    if (drawn) stdout.write(drawn + '\n');
  }

  if (reply.suggestion) {
    const { command, args, why } = reply.suggestion;
    const shown = `/${command}${args.length ? ' ' + args.join(' ') : ''}`;
    stdout.write('\n  ' + c.dim('Suggested: ') + c.cyan(shown) + (why ? c.dim('  — ' + why) : '') + '\n');
    const ok = await confirm(reader, `  Run ${c.cyan(shown)} now?`, true);
    if (ok) {
      stdout.write('\n');
      if (command === 'score') await runScore(args, reader, state, true);
      else if (command === 'skill') await runSkill(args, reader, state, true);
      else await handleSlash(command, args, reader, state, dirs);
    }
  }
  stdout.write('\n');
}

async function runScore(args: string[], reader: LineReader, state: ReplState, fromAgent: boolean): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const repo = positional[0] ?? '.';
  const offline = args.includes('--offline');
  const specsIdx = args.indexOf('--specs');
  const specs = specsIdx >= 0 ? args[specsIdx + 1] : undefined;

  if (fromAgent && !offline) {
    const ok = await confirm(
      reader,
      c.yellow('  score runs the full pipeline and makes real Codex calls against your 5-hour window.') +
        `\n  Score ${c.cyan(repo)}?`,
      false,
    );
    if (!ok) {
      stdout.write(c.dim('  Skipped.\n'));
      return;
    }
  }

  const spinner = new Spinner(`scoring ${repo}…`).start();
  try {
    const { result, summary, jsonPath, htmlPath } = await scoreRepo(repo, {
      offline,
      specs,
      onProgress: (m) => spinner.setLabel(m),
    });
    spinner.stop(c.green('✔'), `scored ${repo}`);
    state.last = { kind: 'score', result };
    printRunOutput(result, summary, jsonPath, htmlPath);
  } catch (err) {
    spinner.fail(`scoring ${repo}`);
    stdout.write(c.yellow(`  Scoring failed: ${err instanceof Error ? err.message : String(err)}\n`));
  }
}

async function runSkill(args: string[], reader: LineReader, state: ReplState, fromAgent: boolean): Promise<void> {
  const bench = args.find((a) => !a.startsWith('--'));
  if (!bench) {
    stdout.write(c.yellow('  Which bench file? Try ') + c.cyan('/skill examples/tax-skill.bench.json') + '\n');
    return;
  }
  if (fromAgent) {
    const ok = await confirm(
      reader,
      c.yellow('  skill makes real Codex calls against your 5-hour window.') + `\n  Run the ${c.cyan(bench)} bench?`,
      false,
    );
    if (!ok) {
      stdout.write(c.dim('  Skipped.\n'));
      return;
    }
  }

  const spinner = new Spinner(`running ${bench}…`).start();
  try {
    const { result, summary, jsonPath, htmlPath } = await benchSkill(bench, {
      onProgress: (m) => spinner.setLabel(m),
    });
    spinner.stop(c.green('✔'), `ran ${bench}`);
    state.last = { kind: 'skill', result };
    printRunOutput(result, summary, jsonPath, htmlPath);
  } catch (err) {
    spinner.fail(`running ${bench}`);
    stdout.write(c.yellow(`  Skill bench failed: ${err instanceof Error ? err.message : String(err)}\n`));
  }
}

/** After a score/skill run: charts if there's an uplift to show, else the text summary. */
function printRunOutput(
  result: Parameters<typeof renderResultCharts>[0],
  summary: string,
  jsonPath: string,
  htmlPath: string,
): void {
  const hasUplift = result.outcomes.length > 0 || result.dimensions.some((d) => d.inUplift);
  if (hasUplift) {
    stdout.write('\n' + renderResultCharts(result) + '\n');
  } else {
    stdout.write('\n' + summary + '\n');
  }
  stdout.write(c.dim(`\n  Wrote ${jsonPath}\n  Wrote ${htmlPath}\n`));
  stdout.write('  ' + c.dim('Ask me to “explain that”, or open the dashboard: ') + c.cyan('/serve') + '\n');
}

async function runHistory(dir: string, state: ReplState): Promise<void> {
  try {
    const entries = await readHistory(resolve(dir));
    state.last = { kind: 'history', entries };
    if (entries.length > 0) {
      const spark = drawChart(state.last, 'history');
      if (spark) stdout.write('\n' + spark + '\n');
    }
    stdout.write('\n' + (await historyReport(dir)) + '\n\n');
  } catch (err) {
    stdout.write(c.yellow(`  That didn’t work: ${err instanceof Error ? err.message : String(err)}\n\n`));
  }
}

async function handleServe(args: string[], state: ReplState, dirs: string[]): Promise<void> {
  if (args[0] === 'stop') {
    if (state.server) {
      await state.server.close().catch(() => {});
      state.server = null;
      stdout.write(c.dim('  Dashboard stopped.\n\n'));
    } else {
      stdout.write(c.dim('  The dashboard isn’t running.\n\n'));
    }
    return;
  }
  if (state.server) {
    stdout.write('  Already serving → ' + c.cyan(state.server.url) + '\n\n');
    return;
  }
  const serveDirs = args.length ? args : dirs;
  try {
    state.server = await serveDashboard({ dirs: serveDirs, port: 4173 });
    stdout.write('\n  Portfolio dashboard → ' + c.cyan(state.server.url) + '\n');
    stdout.write(
      '  ' + c.dim('Loopback only — nothing is exposed to the network. ') + c.cyan('/serve stop') + c.dim(' to stop.\n\n'),
    );
    const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    runProcess(opener, [state.server.url], { timeoutMs: 10_000 }).catch(() => {});
  } catch (err) {
    stdout.write(c.yellow(`  Couldn’t start the dashboard: ${err instanceof Error ? err.message : String(err)}\n\n`));
  }
}

/** Run a text-producing command, stash it as the last result, and print it. */
async function runText(run: () => Promise<string>, stash: (text: string) => void): Promise<void> {
  try {
    const text = await run();
    stash(text);
    stdout.write('\n' + text + '\n\n');
  } catch (err) {
    stdout.write(c.yellow(`  That didn’t work: ${err instanceof Error ? err.message : String(err)}\n\n`));
  }
}

async function confirm(reader: LineReader, question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const raw = await reader.next(`${question} ${c.dim(hint)} `);
  if (raw === null) return false; // stream closed → never fire off an action
  const answer = raw.trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}
