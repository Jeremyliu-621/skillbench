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

/**
 * Render a word as block letters with a 3D drop shadow (Claude-Code style): a
 * bright block face, plus a dim shadow cast one cell down-and-right, derived
 * programmatically from the glyph mask so every letter shadows consistently.
 * Returns 6 rows (5 face + 1 shadow). Unknown chars become blanks.
 */
export function bigText(word: string): string[] {
  const H = 5;
  const SHADOW = 1; // offset down-and-right
  const chars = [...word.toUpperCase()];

  // Build the boolean face mask, glyphs separated by one blank column.
  const mask: boolean[][] = Array.from({ length: H }, () => [] as boolean[]);
  chars.forEach((ch, idx) => {
    const glyph = GLYPHS[ch] ?? GLYPHS[' ']!;
    for (let r = 0; r < H; r++) {
      for (const cell of glyph[r]!) mask[r]!.push(cell === '█');
      if (idx < chars.length - 1) mask[r]!.push(false);
    }
  });
  const W = mask[0]?.length ?? 0;
  const face = (r: number, col: number) => r >= 0 && r < H && col >= 0 && col < W && mask[r]![col]!;

  const rows: string[] = [];
  for (let r = 0; r < H + SHADOW; r++) {
    let line = '';
    for (let col = 0; col < W + SHADOW; col++) {
      if (face(r, col)) line += c.brand('█');
      else if (face(r - SHADOW, col - SHADOW)) line += c.brandDim('▒'); // drop shadow (shaded so it reads without color too)
      else line += ' ';
    }
    rows.push(line);
  }
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
  const wordmark = bigText('2BENCH').map((r) => '  ' + r).join('\n'); // already colored per-cell
  const welcome = box([`${c.brand('✻')} Welcome to ${c.bold('2bench')} — the uplift benchmarker`], {
    color: c.brandDim,
    padX: 2,
  });
  return ['', welcome, '', wordmark, '', '  ' + c.dim('Does your codebase beat a zero-shot LLM? Let’s find out.'), ''].join('\n');
}
