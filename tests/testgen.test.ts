import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isFidelitySuspect, runTestSuite, suiteCachePath } from '../src/stages/testgen.js';
import type { ModuleSpec } from '../src/types.js';

/** These spawn the real child runner (npx tsx) — slower, so one fixture set. */
describe('runTestSuite (child harness)', () => {
  let dir: string;
  let implDir: string;
  let suite: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), '2bench-harness-'));
    implDir = join(dir, 'impl');
    await mkdir(implDir, { recursive: true });
    await writeFile(
      join(implDir, 'calc.ts'),
      `export function add(a: number, b: number): number { return a + b; }
export function div(a: number, b: number): number {
  if (b === 0) throw new Error('division by zero');
  return a / b;
}
console.log('noise on import'); // must not corrupt the result parse
`,
      'utf8',
    );
    suite = join(dir, 'suite.ts');
    await writeFile(
      suite,
      `export const tests = [
  { name: 'adds', run: (s: any, a: any) => a.equal(s.add(2, 3), 5) },
  { name: 'divides', run: (s: any, a: any) => a.equal(s.div(10, 2), 5) },
  { name: 'guards zero', run: (s: any, a: any) => a.throws(() => s.div(1, 0)) },
  { name: 'wrong on purpose', run: (s: any, a: any) => a.equal(s.add(1, 1), 3) },
];\n`,
      'utf8',
    );
  }, 30_000);

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('merges exports into subject and reports pass/fail per test', async () => {
    const run = await runTestSuite(implDir, suite);
    expect(run).not.toBeNull();
    expect(run!.total).toBe(4);
    expect(run!.passed).toBe(3); // 'wrong on purpose' fails
    expect(run!.passRate).toBeCloseTo(0.75, 10);
    expect(run!.failures[0]!.name).toBe('wrong on purpose');
  }, 60_000);

  it('returns null (not 0) when nothing imports — untrustworthy, not all-wrong', async () => {
    const broken = join(dir, 'broken');
    await mkdir(broken, { recursive: true });
    await writeFile(join(broken, 'bad.ts'), `import { gone } from '@alias/nowhere';\nexport const x = gone;\n`, 'utf8');
    const run = await runTestSuite(broken, suite);
    expect(run).toBeNull();
  }, 60_000);
});

describe('suiteCachePath', () => {
  const spec = (title: string): ModuleSpec => ({
    moduleId: 'm',
    title,
    requirements: ['r'],
    interfaces: ['i'],
    constraints: ['c'],
    source: 'extracted',
  });

  it('is stable for the same spec and differs across specs', () => {
    expect(suiteCachePath(spec('a'), '/x')).toBe(suiteCachePath(spec('a'), '/x'));
    expect(suiteCachePath(spec('a'), '/x')).not.toBe(suiteCachePath(spec('b'), '/x'));
    expect(suiteCachePath(spec('a'), '/x')).toMatch(/tests-[0-9a-f]{8}\.ts$/);
  });
});

describe('isFidelitySuspect (D1b guard)', () => {
  const base = { specSource: 'extracted' as const, repoPassRate: 0.12, baselinePassRate: 0.98 };

  it('fires when an extracted spec makes the repo fail its own derived suite', () => {
    expect(isFidelitySuspect(base)).toBe(true);
  });

  it('never fires for authored specs — there the suite tests the real contract', () => {
    expect(isFidelitySuspect({ ...base, specSource: 'linear' })).toBe(false);
  });

  it('fires on the real self-run engine case (0.41 vs 0.82)', () => {
    expect(isFidelitySuspect({ ...base, repoPassRate: 9 / 22, baselinePassRate: 18 / 22 })).toBe(true);
  });

  it('does not fire when the repo merely scores somewhat lower (a real gap)', () => {
    expect(isFidelitySuspect({ ...base, repoPassRate: 0.8, baselinePassRate: 0.9 })).toBe(false);
  });

  it('does not fire when the repo wins', () => {
    expect(isFidelitySuspect({ ...base, repoPassRate: 1, baselinePassRate: 0.4 })).toBe(false);
  });

  it('does not fire when the suite is broken for BOTH sides (baseline unhealthy)', () => {
    // Nothing to indict the spec with — the suite just doesn't work here.
    expect(isFidelitySuspect({ ...base, repoPassRate: 0.05, baselinePassRate: 0.3 })).toBe(false);
  });

  it('needs both sides measured', () => {
    expect(isFidelitySuspect({ ...base, repoPassRate: null })).toBe(false);
    expect(isFidelitySuspect({ ...base, baselinePassRate: null })).toBe(false);
    expect(isFidelitySuspect({ ...base, repoPassRate: 0, baselinePassRate: 0 })).toBe(false);
  });
});
