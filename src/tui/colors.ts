/**
 * Terminal styling primitives — the one place that knows about ANSI.
 *
 * Everything degrades to plain text when output isn't a TTY or NO_COLOR is set,
 * so piped output and CI logs stay clean, and the pure chart/banner functions
 * return the same characters (minus color) that tests can assert on.
 */
import { stdout } from 'node:process';

export const colorEnabled = Boolean(stdout.isTTY) && !process.env.NO_COLOR;

const style = (open: string, close = '0') => (s: string) =>
  colorEnabled ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const c = {
  bold: style('1', '22'),
  dim: style('2', '22'),
  italic: style('3', '23'),
  underline: style('4', '24'),
  red: style('31'),
  green: style('32'),
  yellow: style('33'),
  cyan: style('36'),
  gray: style('90'),
  // True-color violet brand (#8B5CF6) with a darker shade for shadows/dim accents;
  // on a non-truecolor terminal the sequence is ignored and text renders plain.
  brand: style('38;2;139;92;246'),
  brandDim: style('38;2;109;79;196'),
  blue: style('38;5;75'),
};

/** rgb triples used by the pixel mascot (violet robot: body, dark openings, glowing eyes). */
export const RGB = { body: '139;92;246', dark: '30;30;40', glow: '125;211;252' };

/**
 * One half-block cell for pixel art: the character occupies the top and bottom
 * half of the cell independently, so a sprite row-pair renders in one text row.
 * top/bot are "r;g;b" strings, or null for transparent (shows the terminal bg).
 */
export function halfCell(top: string | null, bot: string | null): string {
  if (!colorEnabled) return top && bot ? '█' : top ? '▀' : bot ? '▄' : ' ';
  if (top && bot) return `\x1b[38;2;${top};48;2;${bot}m▀\x1b[0m`;
  if (top) return `\x1b[38;2;${top}m▀\x1b[0m`;
  if (bot) return `\x1b[38;2;${bot}m▄\x1b[0m`;
  return ' ';
}

/** Center a possibly-colored string within `width` visible columns. */
export function centerVisible(s: string, width: number): string {
  const gap = width - visibleWidth(s);
  if (gap <= 0) return s;
  const left = Math.floor(gap / 2);
  return ' '.repeat(left) + s + ' '.repeat(gap - left);
}

const ANSI = /\x1b\[[0-9;]*m/g;

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '');
}

/** Visible column width (ANSI escapes don't take space on screen). */
export function visibleWidth(s: string): number {
  return stripAnsi(s).length;
}

/** Pad a possibly-colored string to `width` visible columns (right pad). */
export function padVisible(s: string, width: number): string {
  const gap = width - visibleWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}
