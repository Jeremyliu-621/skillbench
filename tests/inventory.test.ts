import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { inventory, isSourceFile, sampleModules } from '../src/stages/inventory.js';
import type { ModuleInfo } from '../src/types.js';

describe('isSourceFile', () => {
  it('accepts source, rejects tests/types/other', () => {
    expect(isSourceFile('tax.ts')).toBe(true);
    expect(isSourceFile('App.tsx')).toBe(true);
    expect(isSourceFile('tax.test.ts')).toBe(false);
    expect(isSourceFile('tax.spec.js')).toBe(false);
    expect(isSourceFile('types.d.ts')).toBe(false);
    expect(isSourceFile('README.md')).toBe(false);
  });
});

describe('inventory', () => {
  let repo: string;

  beforeAll(async () => {
    repo = await mkdtemp(join(tmpdir(), '2bench-fixture-'));
    await mkdir(join(repo, 'src', 'services', 'tax'), { recursive: true });
    await mkdir(join(repo, 'src', 'routes'), { recursive: true });
    await mkdir(join(repo, 'node_modules', 'junk'), { recursive: true });
    await writeFile(join(repo, 'src', 'services', 'tax', 'tax.ts'), 'export const a = 1;\nexport const b = 2;\n');
    await writeFile(join(repo, 'src', 'services', 'tax', 'tax.test.ts'), 'test\n');
    await writeFile(join(repo, 'src', 'routes', 'quotes.ts'), 'export const q = 1;\n');
    await writeFile(join(repo, 'node_modules', 'junk', 'x.js'), 'ignored\n');
  });

  afterAll(async () => {
    await rm(repo, { recursive: true, force: true });
  });

  it('groups files by directory, skips node_modules and tests, counts LOC', async () => {
    const inv = await inventory(repo);
    const ids = inv.modules.map((m) => m.id);
    expect(ids).toEqual(['src/routes', 'src/services/tax']);
    const tax = inv.modules.find((m) => m.id === 'src/services/tax')!;
    expect(tax.loc).toBe(2);
    expect(tax.kind).toBe('service');
    expect(tax.subsystem).toBe('src');
    const routes = inv.modules.find((m) => m.id === 'src/routes')!;
    expect(routes.kind).toBe('route');
  });
});

describe('sampleModules', () => {
  const fakeModule = (id: string, subsystem: string, loc = 100): ModuleInfo => ({
    id,
    name: id,
    rootDir: `/repo/${id}`,
    files: [],
    loc,
    subsystem,
    kind: 'lib',
  });

  const modules = [
    ...Array.from({ length: 10 }, (_, i) => fakeModule(`api/m${i}`, 'api')),
    ...Array.from({ length: 6 }, (_, i) => fakeModule(`ui/m${i}`, 'ui')),
    ...Array.from({ length: 4 }, (_, i) => fakeModule(`lib/m${i}`, 'lib')),
  ];

  it('is deterministic under a fixed seed', () => {
    const a = sampleModules(modules, { size: 8, seed: 42 });
    const b = sampleModules(modules, { size: 8, seed: 42 });
    expect(a.map((m) => m.id)).toEqual(b.map((m) => m.id));
  });

  it('changes with the seed', () => {
    const a = sampleModules(modules, { size: 8, seed: 42 });
    const b = sampleModules(modules, { size: 8, seed: 43 });
    expect(a.map((m) => m.id)).not.toEqual(b.map((m) => m.id));
  });

  it('covers every subsystem (stratification floor)', () => {
    const picked = sampleModules(modules, { size: 8, seed: 42 });
    const subsystems = new Set(picked.map((m) => m.subsystem));
    expect(subsystems).toEqual(new Set(['api', 'ui', 'lib']));
    expect(picked).toHaveLength(8);
  });

  it('excludes trivially small modules', () => {
    const withTiny = [...modules, fakeModule('tiny/barrel', 'tiny', 3)];
    const picked = sampleModules(withTiny, { size: 21, seed: 1 });
    expect(picked.map((m) => m.id)).not.toContain('tiny/barrel');
  });

  it('returns everything eligible when the pool is smaller than the request', () => {
    const picked = sampleModules(modules.slice(0, 3), { size: 10, seed: 1 });
    expect(picked).toHaveLength(3);
  });
});
