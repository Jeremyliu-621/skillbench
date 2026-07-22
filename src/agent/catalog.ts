/**
 * The one place that knows what 2bench can do.
 *
 * Three consumers read this list, so they can never drift apart:
 *  - the REPL banner + `/help` (what a newcomer sees on start),
 *  - the concierge system prompt (what the agent knows it can offer), and
 *  - the suggestion whitelist (the agent may only propose a command that is
 *    listed here — an unknown suggestion is dropped, never executed).
 */

export interface CommandDoc {
  /** The verb, as typed after `/` in the REPL or after `2bench` on the shell. */
  name: string;
  /** One-line argument shape, e.g. `score <repo> [--offline]`. */
  usage: string;
  /** A plain-language sentence a newcomer can understand. */
  summary: string;
  /** True when it makes real Codex calls against the 5-hour window — the REPL
   *  confirms before running these so a chat turn can't silently burn budget. */
  costly?: boolean;
  /** True when it starts something long-lived (the local server). */
  longLived?: boolean;
}

export const COMMANDS: readonly CommandDoc[] = [
  {
    name: 'doctor',
    usage: 'doctor',
    summary: 'Check that the engine (Codex) and the code scanners are installed and ready.',
  },
  {
    name: 'inventory',
    usage: 'inventory <repo>',
    summary: 'List a codebase’s modules and show which ones would be sampled for scoring.',
  },
  {
    name: 'score',
    usage: 'score <repo> [--offline] [--specs <dir>]',
    summary: 'The main event: measure how much better a codebase is than a plain zero-shot LLM.',
    costly: true,
  },
  {
    name: 'skill',
    usage: 'skill <bench.json>',
    summary: 'Measure whether a skill (house rules / a prompt) actually beats plain prompting.',
    costly: true,
  },
  {
    name: 'history',
    usage: 'history [dir]',
    summary: 'Show how the uplift score has moved across runs (the LLM baseline is a moving target).',
  },
  {
    name: 'serve',
    usage: 'serve [dirs...]',
    summary: 'Open the portfolio dashboard on localhost — every codebase and skill you’ve scored.',
    longLived: true,
  },
] as const;

export const COMMAND_NAMES: readonly string[] = COMMANDS.map((c) => c.name);

export function findCommand(name: string): CommandDoc | undefined {
  return COMMANDS.find((c) => c.name === name);
}
