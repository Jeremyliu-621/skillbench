/**
 * The interactive agent — the friendly front door.
 *
 * `2bench` with no arguments lands here: a banner, the full command list, and a
 * chat prompt. You can either drive it precisely with slash-commands
 * (`/score .`) — which run immediately and, for the cheap ones, cost nothing —
 * or just talk to it in plain English, in which case the concierge (Codex)
 * answers and may PROPOSE a command that we run only after you say yes.
 *
 * Design: explicit slash-commands are the power-user path and run as typed; the
 * agent's proposals always pass through a confirm gate, so a chat turn can never
 * silently kick off an expensive scoring run.
 */
import { createInterface, type Interface } from 'node:readline/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { stdin, stdout } from 'node:process';
import { COMMANDS } from './agent/catalog.js';
import {
  askConcierge,
  ConciergeError,
  type ConciergeEngine,
  type ConciergeReply,
  type ConciergeTurn,
} from './agent/concierge.js';
import { doctorReport, inventoryReport, historyReport, scoreRepo, benchSkill } from './commands.js';
import { serveDashboard, type ServeHandle } from './serve.js';
import { runProcess } from './engine/proc.js';

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

// ── colour (opt-out, TTY-only) ─────────────────────────────────────────────

const useColor = Boolean(stdout.isTTY) && !process.env.NO_COLOR;
const c = {
  dim: (s: string) => (useColor ? `\x1b[2m${s}\x1b[0m` : s),
  bold: (s: string) => (useColor ? `\x1b[1m${s}\x1b[0m` : s),
  cyan: (s: string) => (useColor ? `\x1b[36m${s}\x1b[0m` : s),
  green: (s: string) => (useColor ? `\x1b[32m${s}\x1b[0m` : s),
  yellow: (s: string) => (useColor ? `\x1b[33m${s}\x1b[0m` : s),
};

function banner(): string {
  // No right-hand border, so colored content never has to line up with a column.
  const rule = '  ' + '─'.repeat(56);
  return [
    '',
    rule,
    '   ' + c.bold(c.cyan('2 B E N C H')),
    '   ' + c.dim('Does your codebase beat a zero-shot LLM?'),
    rule,
  ].join('\n');
}

function commandList(): string {
  const lines = [c.bold('  What I can do')];
  for (const cmd of COMMANDS) {
    const tag = cmd.costly ? c.yellow(' (uses Codex)') : cmd.longLived ? c.dim(' (opens a page)') : '';
    // Pad the plain label first, THEN colour the whole cell — exact alignment.
    const label = c.cyan(('/' + cmd.name).padEnd(11));
    lines.push(`    ${label} ${cmd.summary}${tag}`);
  }
  lines.push('');
  lines.push('  ' + c.dim('Or just ask me a question in plain English. ') + c.cyan('/help') + c.dim(' · ') + c.cyan('/quit'));
  return lines.join('\n');
}

// ── state ──────────────────────────────────────────────────────────────────

interface ReplState {
  history: ConciergeTurn[];
  server: ServeHandle | null;
}

export interface ReplOptions {
  /** Directories the dashboard reads (for `/serve`). Defaults to the two standard out dirs. */
  dirs?: string[];
  /** Injectable concierge engine (tests pass a fake; production uses Codex). */
  conciergeEngine?: ConciergeEngine;
}

export async function startRepl(opts: ReplOptions = {}): Promise<void> {
  const rl = createInterface({ input: stdin, output: stdout });
  const state: ReplState = { history: [], server: null };
  const dirs = opts.dirs ?? ['.2bench', '.2bench-skill'];
  const cwd = process.cwd();
  const ctx = { cwd, isGitRepo: existsSync(join(cwd, '.git')) };

  stdout.write(banner() + '\n\n' + commandList() + '\n\n');
  stdout.write(c.dim('  Tip: chatting sends a small request to Codex on your subscription.\n\n'));

  let running = true;
  rl.on('SIGINT', () => {
    running = false;
    rl.close();
  });

  while (running) {
    const line = await prompt(rl, c.green('  2bench ▸ '));
    if (line === null) break; // stream closed (Ctrl+C / Ctrl+D / EOF)
    const parsed = parseReplLine(line);

    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'chat') {
      await handleChat(parsed.text, rl, state, ctx, dirs, opts.conciergeEngine);
      continue;
    }

    // slash command
    const done = await handleSlash(parsed.command, parsed.args, rl, state, dirs);
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
  rl: Interface,
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
      if (stdout.isTTY) stdout.write('\x1b[2J\x1b[H');
      stdout.write(c.dim('  Fresh start — conversation cleared.\n\n'));
      return false;
    case 'doctor':
      await printResult(() => doctorReport());
      return false;
    case 'inventory': {
      const repo = args[0] ?? '.';
      await printResult(() => inventoryReport(repo, {}));
      return false;
    }
    case 'history': {
      const dir = args[0] ?? dirs[0]!;
      await printResult(() => historyReport(dir));
      return false;
    }
    case 'score':
      await runScore(args, rl, /* fromAgent */ false);
      return false;
    case 'skill':
      await runSkill(args, rl, /* fromAgent */ false);
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
  rl: Interface,
  state: ReplState,
  ctx: { cwd: string; isGitRepo: boolean },
  dirs: string[],
  engine?: ConciergeEngine,
): Promise<void> {
  stdout.write(c.dim('  (thinking…)\n'));
  let reply: ConciergeReply;
  try {
    reply = await askConcierge(text, state.history, ctx, engine);
  } catch (err) {
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

  if (reply.suggestion) {
    const { command, args, why } = reply.suggestion;
    const shown = `/${command}${args.length ? ' ' + args.join(' ') : ''}`;
    stdout.write('\n  ' + c.dim('Suggested: ') + c.cyan(shown) + (why ? c.dim('  — ' + why) : '') + '\n');
    const ok = await confirm(rl, `  Run ${c.cyan(shown)} now?`, true);
    if (ok) {
      stdout.write('\n');
      if (command === 'score') await runScore(args, rl, true);
      else if (command === 'skill') await runSkill(args, rl, true);
      else await handleSlash(command, args, rl, state, dirs);
    }
  }
  stdout.write('\n');
}

async function runScore(args: string[], rl: Interface, fromAgent: boolean): Promise<void> {
  const positional = args.filter((a) => !a.startsWith('--'));
  const repo = positional[0] ?? '.';
  const offline = args.includes('--offline');
  const specsIdx = args.indexOf('--specs');
  const specs = specsIdx >= 0 ? args[specsIdx + 1] : undefined;

  if (fromAgent && !offline) {
    const ok = await confirm(
      rl,
      c.yellow('  score runs the full pipeline and makes real Codex calls against your 5-hour window.') +
        `\n  Score ${c.cyan(repo)}?`,
      false,
    );
    if (!ok) {
      stdout.write(c.dim('  Skipped.\n'));
      return;
    }
  }
  try {
    const { summary, jsonPath, htmlPath } = await scoreRepo(repo, {
      offline,
      specs,
      onProgress: (m) => stdout.write('  ' + c.dim(m) + '\n'),
    });
    stdout.write(summary + '\n');
    stdout.write(c.dim(`  Wrote ${jsonPath}\n  Wrote ${htmlPath}\n`));
    stdout.write('  ' + c.dim('See it on the dashboard: ') + c.cyan('/serve') + '\n');
  } catch (err) {
    stdout.write(c.yellow(`  Scoring failed: ${err instanceof Error ? err.message : String(err)}\n`));
  }
}

async function runSkill(args: string[], rl: Interface, fromAgent: boolean): Promise<void> {
  const bench = args.find((a) => !a.startsWith('--'));
  if (!bench) {
    stdout.write(c.yellow('  Which bench file? Try ') + c.cyan('/skill examples/tax-skill.bench.json') + '\n');
    return;
  }
  if (fromAgent) {
    const ok = await confirm(
      rl,
      c.yellow('  skill makes real Codex calls against your 5-hour window.') + `\n  Run the ${c.cyan(bench)} bench?`,
      false,
    );
    if (!ok) {
      stdout.write(c.dim('  Skipped.\n'));
      return;
    }
  }
  try {
    const { summary, jsonPath, htmlPath } = await benchSkill(bench, {
      onProgress: (m) => stdout.write('  ' + c.dim(m) + '\n'),
    });
    stdout.write(summary + '\n');
    stdout.write(c.dim(`  Wrote ${jsonPath}\n  Wrote ${htmlPath}\n`));
  } catch (err) {
    stdout.write(c.yellow(`  Skill bench failed: ${err instanceof Error ? err.message : String(err)}\n`));
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
  const serveDirs = (args.length ? args : dirs).map((d) => d);
  try {
    state.server = await serveDashboard({ dirs: serveDirs, port: 4173 });
    stdout.write('\n  Portfolio dashboard → ' + c.cyan(state.server.url) + '\n');
    stdout.write('  ' + c.dim('Loopback only — nothing is exposed to the network. ') + c.cyan('/serve stop') + c.dim(' to stop.\n\n'));
    // Best-effort open in the default browser.
    const opener = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    runProcess(opener, [state.server.url], { timeoutMs: 10_000 }).catch(() => {});
  } catch (err) {
    stdout.write(c.yellow(`  Couldn’t start the dashboard: ${err instanceof Error ? err.message : String(err)}\n\n`));
  }
}

async function printResult(run: () => Promise<string>): Promise<void> {
  try {
    stdout.write('\n' + (await run()) + '\n\n');
  } catch (err) {
    stdout.write(c.yellow(`  That didn’t work: ${err instanceof Error ? err.message : String(err)}\n\n`));
  }
}

async function confirm(rl: Interface, question: string, defaultYes: boolean): Promise<boolean> {
  const hint = defaultYes ? '[Y/n]' : '[y/N]';
  const raw = await prompt(rl, `${question} ${c.dim(hint)} `);
  if (raw === null) return false; // stream closed → never fire off an action
  const answer = raw.trim().toLowerCase();
  if (!answer) return defaultYes;
  return answer === 'y' || answer === 'yes';
}

/** rl.question that resolves to null when the input stream closes, so a
 *  Ctrl+C / Ctrl+D / EOF ends the session cleanly instead of throwing. */
async function prompt(rl: Interface, q: string): Promise<string | null> {
  try {
    return await rl.question(q);
  } catch {
    return null;
  }
}
