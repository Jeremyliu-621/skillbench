import { describe, expect, it } from 'vitest';
import { parseReplLine } from '../src/repl.js';
import {
  askConcierge,
  buildConciergePrompt,
  ConciergeError,
  normalizeReply,
  type ConciergeEngine,
} from '../src/agent/concierge.js';
import { COMMAND_NAMES } from '../src/agent/catalog.js';

describe('parseReplLine', () => {
  it('treats a leading slash as a command and lowercases the verb', () => {
    expect(parseReplLine('/Score . --offline')).toEqual({
      kind: 'slash',
      command: 'score',
      args: ['.', '--offline'],
    });
  });

  it('treats bare text as a chat message', () => {
    expect(parseReplLine('how good is this repo?')).toEqual({
      kind: 'chat',
      text: 'how good is this repo?',
    });
  });

  it('collapses whitespace and ignores blank lines', () => {
    expect(parseReplLine('   ')).toEqual({ kind: 'empty' });
    expect(parseReplLine('  /help   ')).toEqual({ kind: 'slash', command: 'help', args: [] });
    expect(parseReplLine('/inventory    ./repo')).toEqual({
      kind: 'slash',
      command: 'inventory',
      args: ['./repo'],
    });
  });
});

describe('normalizeReply', () => {
  it('keeps a suggestion whose command is in the catalog', () => {
    const r = normalizeReply({
      reply: 'Let’s check the codebase.',
      suggestion: { command: 'score', args: ['.'], why: 'you asked to grade this repo' },
    });
    expect(r.suggestion).toEqual({ command: 'score', args: ['.'], why: 'you asked to grade this repo' });
  });

  it('drops a suggestion whose command is NOT in the catalog (never execute unknowns)', () => {
    const r = normalizeReply({
      reply: 'sure',
      suggestion: { command: 'rm', args: ['-rf', '/'], why: 'malicious' },
    });
    expect(r.suggestion).toBeNull();
    expect(COMMAND_NAMES).not.toContain('rm');
  });

  it('treats a null suggestion as purely conversational', () => {
    const r = normalizeReply({ reply: 'It measures uplift over a zero-shot LLM.', suggestion: null });
    expect(r.suggestion).toBeNull();
    expect(r.reply).toContain('uplift');
  });

  it('filters non-string args and defaults a missing why', () => {
    const r = normalizeReply({
      reply: 'ok',
      suggestion: { command: 'inventory', args: ['.', 5, null, 'x'], why: undefined },
    });
    expect(r.suggestion).toEqual({ command: 'inventory', args: ['.', 'x'], why: '' });
  });

  it('rejects an empty or missing reply', () => {
    expect(() => normalizeReply({ reply: '', suggestion: null })).toThrow(ConciergeError);
    expect(() => normalizeReply({ suggestion: null })).toThrow(ConciergeError);
    expect(() => normalizeReply(null)).toThrow(ConciergeError);
  });
});

describe('buildConciergePrompt', () => {
  it('embeds the catalog, the cwd context, and the conversation', () => {
    const prompt = buildConciergePrompt(
      'can you score this?',
      [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello!' },
      ],
      { cwd: '/work/erp', isGitRepo: true },
    );
    for (const name of COMMAND_NAMES) expect(prompt).toContain(name);
    expect(prompt).toContain('/work/erp');
    expect(prompt).toContain('Is a git repo: yes');
    expect(prompt).toContain('User: hi');
    expect(prompt).toContain('You: hello!');
    expect(prompt).toContain('User: can you score this?');
  });
});

describe('askConcierge (fake engine — no Codex)', () => {
  const ctx = { cwd: '/repo', isGitRepo: true };

  it('parses and normalizes the engine reply', async () => {
    const engine: ConciergeEngine = {
      ask: async () =>
        JSON.stringify({ reply: 'Sure — I can score the current directory.', suggestion: { command: 'score', args: ['.'], why: 'grade this repo' } }),
    };
    const r = await askConcierge('grade my repo', [], ctx, engine);
    expect(r.reply).toContain('score');
    expect(r.suggestion?.command).toBe('score');
  });

  it('surfaces non-JSON engine output as a ConciergeError', async () => {
    const engine: ConciergeEngine = { ask: async () => 'I am not JSON' };
    await expect(askConcierge('hi', [], ctx, engine)).rejects.toThrow(ConciergeError);
  });

  it('passes the schema to the engine (structured output is required)', async () => {
    let seenSchema: object | null = null;
    const engine: ConciergeEngine = {
      ask: async (_p, schema) => {
        seenSchema = schema;
        return JSON.stringify({ reply: 'hello', suggestion: null });
      },
    };
    await askConcierge('hello', [], ctx, engine);
    expect(seenSchema).not.toBeNull();
    expect(JSON.stringify(seenSchema)).toContain('suggestion');
  });
});
