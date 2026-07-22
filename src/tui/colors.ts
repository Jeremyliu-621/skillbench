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
  // 256-color brand tones (warm amber), with graceful fallbacks handled by the terminal.
  brand: style('38;5;209'),
  brandDim: style('38;5;173'),
  blue: style('38;5;75'),
};

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
