/**
 * The startup banner: a block-letter wordmark + rounded frames, à la a polished
 * CLI. Pure string builders (no I/O) so they're testable and reusable.
 */
import { c, visibleWidth, padVisible, centerVisible, halfCell, RGB } from './colors.js';

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

// A little robot, drawn with half-blocks (2 sprite rows per text row):
// O = body, E = glowing eye, X = dark opening (mouth slot), '.' = transparent.
const SPRITE = [
  '.....OOOO.....',
  '......OO......',
  '..OOOOOOOOOO..',
  '.OOOOOOOOOOOO.',
  '.OEEOOOOOOEEO.',
  '.OEEOOOOOOEEO.',
  '.OOOOOOOOOOOO.',
  '.OOXXXXXXXXOO.',
  '.OOOOOOOOOOOO.',
  '..OOOOOOOOOO..',
  '...O......O...',
  '...O......O...',
];

/** Render the mascot as colored half-block rows (6 text rows, 14 columns). */
export function mascot(): string[] {
  const colorOf = (ch: string | undefined): string | null =>
    ch === 'O' ? RGB.body : ch === 'E' ? RGB.glow : ch === 'X' ? RGB.dark : null;
  const rows: string[] = [];
  for (let r = 0; r < SPRITE.length; r += 2) {
    const top = SPRITE[r]!;
    const bot = SPRITE[r + 1] ?? '';
    let line = '';
    for (let col = 0; col < top.length; col++) line += halfCell(colorOf(top[col]), colorOf(bot[col]));
    rows.push(line);
  }
  return rows;
}

export interface WelcomeData {
  version: string;
  cwd: string;
  engine: string;
  recent: { ago: string; text: string }[];
  commands: { name: string; summary: string }[];
}

const trunc = (s: string, w: number): string => (s.length <= w ? s : '…' + s.slice(-(w - 1))); // keep the tail (paths)
const truncHead = (s: string, w: number): string => (s.length <= w ? s : s.slice(0, w - 1) + '…'); // keep the head (prose)

/** The dashed two-panel welcome dashboard (left: mascot + context, right: activity + commands). */
export function welcomeScreen(data: WelcomeData): string {
  const LEFTW = 30;
  const RIGHTW = 40;

  const left: string[] = [
    '',
    centerVisible('Welcome to ' + c.brand('2bench') + '!', LEFTW),
    '',
    ...mascot().map((row) => centerVisible(row, LEFTW)),
    '',
    centerVisible(c.dim(data.engine), LEFTW),
    centerVisible(c.dim(trunc(data.cwd, LEFTW)), LEFTW),
  ];

  const right: string[] = [c.brand('Recent activity')];
  if (data.recent.length === 0) {
    right.push(c.dim('no runs yet — try /score .'));
  } else {
    for (const r of data.recent.slice(0, 4)) right.push(`${c.dim(r.ago.padEnd(7))} ${r.text}`);
  }
  right.push(c.dim('… /history for more'), c.brandDim('┄'.repeat(RIGHTW)), c.brand('Commands'));
  for (const cmd of data.commands.slice(0, 4)) {
    right.push(`${c.cyan(('/' + cmd.name).padEnd(10))} ${c.dim(truncHead(cmd.summary, RIGHTW - 12))}`);
  }
  right.push(c.dim('… /help for more'));

  const inner = LEFTW + RIGHTW + 5; // between the outer corners
  const title = c.brand(`2bench ${data.version}`);
  const fill = Math.max(0, inner - 3 - visibleWidth(title) - 1);
  const top = c.brandDim('┌┄┄ ') + title + c.brandDim(' ' + '┄'.repeat(fill) + '┐');
  const bottom = c.brandDim('└' + '┄'.repeat(inner) + '┘');

  const rows = Math.max(left.length, right.length);
  const body: string[] = [];
  for (let i = 0; i < rows; i++) {
    const l = padVisible(left[i] ?? '', LEFTW);
    const r = padVisible(right[i] ?? '', RIGHTW);
    body.push(`${c.brandDim('┆')} ${l} ${c.brandDim('┆')} ${r} ${c.brandDim('┆')}`);
  }

  return ['', top, ...body, bottom].join('\n');
}
