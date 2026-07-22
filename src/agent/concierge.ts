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

export interface ConciergeContext {
  /** Where the user launched the agent — the natural default repo to score. */
  cwd: string;
  /** Whether cwd is a git repo (a hint that "score this" means cwd). */
  isGitRepo: boolean;
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
  required: ['reply', 'suggestion'],
  properties: {
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
    'HOW TO RESPOND:',
    '  - Keep "reply" short and human. Answer the actual question first.',
    '  - You cannot run anything or see command output. If the user clearly wants to DO',
    '    something a command covers, put it in "suggestion" and the app will offer to run',
    '    it after they confirm. Otherwise set "suggestion" to null.',
    '  - Never invent results, scores, or numbers — you have not run anything.',
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
  return { reply, suggestion };
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
