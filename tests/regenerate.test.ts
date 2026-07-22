import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeGeneratedFiles } from '../src/stages/regenerate.js';

describe('writeGeneratedFiles', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), '2bench-regen-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes files (creating nested dirs) and returns the count', async () => {
    const n = await writeGeneratedFiles(dir, [
      { path: 'index.ts', content: 'export const a = 1;' },
      { path: 'lib/util.ts', content: 'export const b = 2;' },
    ]);
    expect(n).toBe(2);
    expect(await readFile(join(dir, 'index.ts'), 'utf8')).toContain('a = 1');
    expect(await readFile(join(dir, 'lib', 'util.ts'), 'utf8')).toContain('b = 2');
  });

  it('refuses paths that escape the candidate dir (traversal guard)', async () => {
    const n = await writeGeneratedFiles(dir, [
      { path: '../escape.ts', content: 'nope' },
      { path: '/abs.ts', content: 'stripped-to-relative' },
      { path: 'ok.ts', content: 'fine' },
    ]);
    // '../escape.ts' rejected; '/abs.ts' de-rooted to abs.ts under dir; 'ok.ts' written.
    const entries = await readdir(dir);
    expect(entries).toContain('ok.ts');
    expect(entries).toContain('abs.ts');
    expect(entries).not.toContain('escape.ts');
    expect(n).toBe(2);
  });

  it('handles an empty files array without error', async () => {
    expect(await writeGeneratedFiles(dir, [])).toBe(0);
  });
});
