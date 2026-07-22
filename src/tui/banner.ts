/**
 * The startup banner: a block-letter wordmark + rounded frames, à la a polished
 * CLI. Pure string builders (no I/O) so they're testable and reusable.
 */
import { c, visibleWidth, padVisible } from './colors.js';

// 5-row block glyphs for the characters in "2BENCH". Each row is 5 columns.
const GLYPHS: Record<string, string[]> = {
  '2': ['█████', '    █', '█████', '█    ', '█████'],
  B: ['████ ', '█   █', '████ ', '█   █', '████ '],
  E: ['█████', '█    ', '███  ', '█    ', '█████'],
  N: ['█   █', '██  █', '█ █ █', '█  ██', '█   █'],
  C: ['█████', '█    ', '█    ', '█    ', '█████'],
  H: ['█   █', '█   █', '█████', '█   █', '█   █'],
  ' ': ['  ', '  ', '  ', '  ', '  '],
};

/** Render a word as 5 rows of block letters. Unknown chars become blanks. */
export function bigText(word: string): string[] {
  const rows = ['', '', '', '', ''];
  const chars = [...word.toUpperCase()];
  chars.forEach((ch, idx) => {
    const glyph = GLYPHS[ch] ?? GLYPHS[' ']!;
    for (let r = 0; r < 5; r++) {
      rows[r] += glyph[r] + (idx < chars.length - 1 ? ' ' : '');
    }
  });
  return rows;
}

/** A rounded box around content lines, sized to the widest visible line. */
export function box(lines: string[], opts: { padX?: number; color?: (s: string) => string } = {}): string {
  const padX = opts.padX ?? 1;
  const tint = opts.color ?? c.gray;
  const inner = Math.max(...lines.map(visibleWidth));
  const width = inner + padX * 2;
  const top = tint('╭' + '─'.repeat(width) + '╮');
  const bot = tint('╰' + '─'.repeat(width) + '╯');
  const body = lines.map(
    (l) => tint('│') + ' '.repeat(padX) + padVisible(l, inner) + ' '.repeat(padX) + tint('│'),
  );
  return [top, ...body, bot].join('\n');
}

/** The full opening screen: welcome box → wordmark → tagline. */
export function banner(): string {
  const wordmark = bigText('2BENCH').map((r) => '  ' + c.brand(r)).join('\n');
  const welcome = box([`${c.brand('✻')} Welcome to ${c.bold('2bench')} — the uplift benchmarker`], {
    color: c.brandDim,
    padX: 2,
  });
  return ['', welcome, '', wordmark, '', '  ' + c.dim('Does your codebase beat a zero-shot LLM? Let’s find out.'), ''].join('\n');
}
