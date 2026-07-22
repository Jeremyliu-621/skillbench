/**
 * Braille spinner ("bobber") for async work. Animates only on a real TTY; in a
 * pipe/CI it just prints the label lines, so logs stay readable.
 */
import { stdout } from 'node:process';
import { c, colorEnabled } from './colors.js';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** Pure frame selector (unit-tested). */
export function spinnerFrame(i: number): string {
  return FRAMES[((i % FRAMES.length) + FRAMES.length) % FRAMES.length]!;
}

const animated = () => colorEnabled && Boolean(stdout.isTTY);

export class Spinner {
  private i = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private label: string;

  constructor(label: string) {
    this.label = label;
  }

  start(): this {
    if (!animated()) {
      stdout.write(`  ${this.label}…\n`);
      return this;
    }
    stdout.write('\x1b[?25l'); // hide cursor
    this.render();
    this.timer = setInterval(() => this.render(), 80);
    return this;
  }

  setLabel(label: string): void {
    if (!animated()) {
      if (label !== this.label) stdout.write(`  ${label}…\n`);
      this.label = label;
      return;
    }
    this.label = label;
  }

  stop(symbol = c.green('✔'), finalLabel = this.label): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!animated()) {
      stdout.write(`  ${finalLabel} — done\n`);
      return;
    }
    stdout.write(`\r  ${symbol} ${finalLabel}\x1b[K\n`); // overwrite spinner line + clear tail
    stdout.write('\x1b[?25h'); // show cursor
  }

  fail(finalLabel = this.label): void {
    this.stop(c.red('✖'), finalLabel);
  }

  /** Stop and erase the line entirely (no checkmark) — used for the chat "thinking" spinner. */
  clear(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (!animated()) return;
    stdout.write('\r\x1b[K\x1b[?25h');
  }

  private render(): void {
    stdout.write(`\r  ${c.brand(spinnerFrame(this.i++))} ${this.label}\x1b[K`);
  }
}

/** Run an async task under a spinner; resolves/rejects with the task's result. */
export async function withSpinner<T>(label: string, task: () => Promise<T>): Promise<T> {
  const spinner = new Spinner(label).start();
  try {
    const result = await task();
    spinner.stop();
    return result;
  } catch (err) {
    spinner.fail();
    throw err;
  }
}
