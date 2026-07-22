/**
 * The concierge: the friendly agent behind the chat prompt.
 *
 * It is deliberately NOT an autopilot. Given a plain-English message it returns
 * (a) a short, newcomer-friendly reply and (b) OPTIONALLY one command to
 * propose — which the REPL runs only after the human confirms. The agent can
 * never execute anything itself, and it may only propose a command that exists
 * in the shared catalog (an unknown suggestion is dropped). That keeps the
 * expensive scoring runs behind a human "yes" and keeps the tool honest about
 * what it can do.
 *
 * Engine is injected (mirrors PipelineEngine/SkillEngine) so tests drive it with
 * a fake and never touch Codex.
 */
import { codexExec } from '../engine/codex.js';
import { COMMANDS, COMMAND_NAMES } from './catalog.js';

/** Charts the REPL can draw from a command's structured result (LLM never draws ASCII itself). */
export const CHART_NAMES = ['result', 'dimensions', 'uplift', 'winrate', 'history'] as const;
export type ChartName = (typeof CHART_NAMES)[number];

export interface ConciergeContext {
  /** Where the user launched the agent — the natural default repo to score. */
  cwd: string;
  /** Whether cwd is a git repo (a hint that "score this" means cwd). */
  isGitRepo: boolean;
  /** Compact summary of the last command's result, so the agent can explain it. */
  resultDigest?: string | null;
  /** Chart names the app can actually draw from that result right now (a subset of CHART_NAMES). */
  availableCharts?: readonly string[];
}

export interface ConciergeTurn {
  role: 'user' | 'assistant';
  content: string;
}

export interface CommandSuggestion {
  command: string;
  args: string[];
  why: string;
}

export interface ConciergeReply {
  reply: string;
  /** A command to offer the user, or null when the turn is purely conversational. */
  suggestion: CommandSuggestion | null;
  /** A chart to draw beneath the reply (from real data), or 'none'. */
  chart: string;
}

/** Injectable transport. Returns Codex's schema-constrained final message (JSON text). */
export interface ConciergeEngine {
  ask(prompt: string, schema: object): Promise<string>;
}

export class ConciergeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConciergeError';
  }
}

const REPLY_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['reply', 'suggestion', 'chart'],
  properties: {
    chart: {
      type: 'string',
      enum: ['none', ...CHART_NAMES],
      description:
        'A chart to draw beneath your reply when a picture helps explain the last result — but ONLY a name listed as available in the prompt. Otherwise "none". The app draws it from real data; you never draw ASCII charts yourself.',
    },
    reply: {
      type: 'string',
      description: 'A short, warm, plain-language answer for the user. A few sentences at most.',
    },
    suggestion: {
      type: ['object', 'null'],
      additionalProperties: false,
      required: ['command', 'args', 'why'],
      description: 'One command to offer the user, or null if the message needs no command.',
      properties: {
        command: { type: 'string', enum: [...COMMAND_NAMES] },
        args: {
          type: 'array',
          items: { type: 'string' },
          description: 'Arguments for the command, e.g. ["."] to score the current directory.',
        },
        why: { type: 'string', description: 'One line: why this command answers what they asked.' },
      },
    },
  },
} as const;

/** The default engine: a single low-effort Codex call, read-only, tight timeout. */
export const codexConciergeEngine: ConciergeEngine = {
  async ask(prompt, schema) {
    const result = await codexExec(prompt, {
      cwd: process.cwd(),
      sandbox: 'read-only',
      reasoningEffort: 'low',
      outputSchema: schema,
      timeoutMs: 120_000,
    });
    return result.finalMessage;
  },
};

export function buildConciergePrompt(
  message: string,
  history: readonly ConciergeTurn[],
  ctx: ConciergeContext,
): string {
  const catalog = COMMANDS.map(
    (c) => `  - ${c.name} — ${c.summary} (usage: ${c.usage})${c.costly ? ' [makes real Codex calls]' : ''}`,
  ).join('\n');

  const transcript = history
    .map((t) => `${t.role === 'user' ? 'User' : 'You'}: ${t.content}`)
    .join('\n');

  const chartDesc: Record<string, string> = {
    result: 'full breakdown — dimension bars + the uplift gauge',
    dimensions: 'per-dimension bars (your code vs the zero-shot rebuild)',
    uplift: 'the uplift gauge against the 40% gate',
    winrate: 'the head-to-head win-rate bar',
    history: 'the uplift-over-time sparkline',
  };
  const avail = ctx.availableCharts ?? [];
  const chartsBlock = avail.length
    ? avail.map((n) => `  - ${n}: ${chartDesc[n] ?? ''}`).join('\n')
    : '  (no chart is available for the last result — use "none")';

  return [
    'You are the concierge for 2bench — a friendly guide inside its terminal app.',
    'You help a newcomer understand and use the tool, in warm, plain language. No jargon dumps.',
    '',
    'WHAT 2BENCH DOES (explain it this simply):',
    '  It measures whether custom AI work is actually worth it. It takes a codebase',
    '  (or a "skill" — a set of house rules / a reusable prompt), asks a plain zero-shot',
    '  LLM to build the same thing from just the spec, and scores both on correctness,',
    '  security, maintainability, and consistency. The headline is the "uplift %": how',
    '  much better the real thing is than what a plain LLM would have produced. The rule',
    '  it enforces: custom work must beat zero-shot by at least 40%.',
    '  It can — and often does — return "no, this does not clear the bar." That honesty',
    '  is the point; never oversell.',
    '',
    'COMMANDS YOU CAN OFFER (only these):',
    catalog,
    '',
    'CONTEXT:',
    `  Working directory: ${ctx.cwd}`,
    `  Is a git repo: ${ctx.isGitRepo ? 'yes' : 'no'} (if they say "this repo"/"here", that means ".")`,
    '',
    "THE USER'S LAST COMMAND RESULT (they may ask you to explain it):",
    ctx.resultDigest ? ctx.resultDigest : '  (nothing has been run yet)',
    '',
    'CHARTS YOU CAN DRAW (set "chart" to one when a picture helps explain the result):',
    chartsBlock,
    '',
    'HOW TO RESPOND:',
    '  - Keep "reply" short and human. Answer the actual question first.',
    '  - You cannot run anything or see raw command output beyond the result summary above.',
    '    If the user clearly wants to DO something a command covers, put it in "suggestion"',
    '    and the app will offer to run it after they confirm. Otherwise set "suggestion" to null.',
    '  - If they ask you to explain the last result, explain it in plain words from the summary',
    '    above, and set "chart" to one of the AVAILABLE names when a diagram helps (else "none").',
    '    NEVER put ASCII art or charts in "reply" — the app draws the chart from real data.',
    '  - Never invent results, scores, or numbers — rely only on the summary above.',
    '  - "score" and "skill" make real Codex calls against the user\'s 5-hour usage window;',
    '    mention that briefly when you suggest one.',
    '  - Prefer suggesting "doctor" or "inventory ." for a nervous newcomer before a full score.',
    '',
    transcript ? `CONVERSATION SO FAR:\n${transcript}\n` : '',
    `User: ${message}`,
    '',
    'Respond with the JSON object only.',
  ].join('\n');
}

/** Validate + normalize a raw suggestion; drop anything not in the catalog. */
export function normalizeReply(raw: unknown): ConciergeReply {
  if (!raw || typeof raw !== 'object') {
    throw new ConciergeError('concierge returned a non-object reply');
  }
  const obj = raw as Record<string, unknown>;
  const reply = typeof obj.reply === 'string' ? obj.reply.trim() : '';
  if (!reply) throw new ConciergeError('concierge returned an empty reply');

  let suggestion: CommandSuggestion | null = null;
  const s = obj.suggestion;
  if (s && typeof s === 'object') {
    const so = s as Record<string, unknown>;
    const command = typeof so.command === 'string' ? so.command : '';
    if (COMMAND_NAMES.includes(command)) {
      const args = Array.isArray(so.args) ? so.args.filter((a): a is string => typeof a === 'string') : [];
      suggestion = { command, args, why: typeof so.why === 'string' ? so.why : '' };
    }
    // command not in the catalog → silently drop the suggestion (never execute unknowns)
  }

  // Chart choice; the REPL still validates it against what's actually drawable now.
  const chart =
    typeof obj.chart === 'string' && (CHART_NAMES as readonly string[]).includes(obj.chart) ? obj.chart : 'none';

  return { reply, suggestion, chart };
}

export async function askConcierge(
  message: string,
  history: readonly ConciergeTurn[],
  ctx: ConciergeContext,
  engine: ConciergeEngine = codexConciergeEngine,
): Promise<ConciergeReply> {
  const prompt = buildConciergePrompt(message, history, ctx);
  const finalMessage = await engine.ask(prompt, REPLY_SCHEMA);
  let parsed: unknown;
  try {
    parsed = JSON.parse(finalMessage);
  } catch {
    throw new ConciergeError(`concierge returned non-JSON: ${finalMessage.slice(0, 200)}`);
  }
  return normalizeReply(parsed);
}
