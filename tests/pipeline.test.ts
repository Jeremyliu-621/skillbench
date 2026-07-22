import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runPipeline, averageDeterministic, type PipelineEngine } from '../src/pipeline.js';
import { suiteCachePath } from '../src/stages/testgen.js';
import { loadConfig } from '../src/config.js';
import type { BenchConfig, DeterministicScores } from '../src/types.js';

// Fake engine: no Codex. Regenerates a deliberately worse baseline (a very
// complex function) so the repo should win maintainability deterministically.
const WORSE_BASELINE = `export function compute(a,b,c,d){
  ${Array.from({ length: 25 }, (_, i) => `if(a===${i}||b===${i}&&c>${i}?d:0){return ${i};}`).join('\n  ')}
  return 0;
}`;

/** A clean, simple, ~35-line module (low complexity → should beat the baseline). */
function cleanModule(name: string): string {
  const lines = [`// ${name} service — clean, simple implementation`];
  for (let i = 0; i < 12; i++) {
    lines.push(
      `export function ${name}Step${i}(input: number): number {`,
      `  const rate = ${(1 + i / 100).toFixed(2)};`,
      `  return input * rate;`,
      `}`,
    );
  }
  return lines.join('\n') + '\n';
}

const fakeEngine: PipelineEngine = {
  async extractSpec(module) {
    return {
      moduleId: module.id,
      title: `Spec for ${module.name}`,
      requirements: ['do the thing'],
      interfaces: ['compute(a,b,c,d): number'],
      constraints: ['no side effects'],
      source: 'extracted',
    };
  },
  async regenerate(spec, workRoot, config) {
    const out = [];
    for (let s = 0; s < config.baseline.samplesPerSpec; s++) {
      const dir = join(workRoot, 'baseline', `s${s}`);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, 'impl.ts'), `${WORSE_BASELINE}\n// sample ${s}`, 'utf8');
      out.push({ moduleId: spec.moduleId, dir, sampleIndex: s, promptIndex: 0, tokensUsed: 100 });
    }
    return out;
  },
  async generateTests(spec, cacheDir) {
    // Hand-authored shared suite the clean repo passes and WORSE_BASELINE fails:
    // probes <module>StepN (repo shape) with a compute() fallback (baseline shape).
    const fn = spec.moduleId.split('/').pop()!; // 'tax' | 'pricing'
    const path = suiteCachePath(spec, cacheDir);
    await writeFile(
      path,
      `export const tests = [
        { name: 'exposes interface', run: (s, a) => a.ok(typeof (s.${fn}Step0 ?? s.compute) === 'function') },
        { name: 'step0 rate', run: (s, a) => { const f = s.${fn}Step0 ?? ((x) => s.compute(x, 1, 2, 3)); a.equal(Math.round(f(100)), 100); } },
        { name: 'step2 rate', run: (s, a) => { const f = s.${fn}Step2 ?? ((x) => s.compute(x, 9, 9, 9)); a.equal(Math.round(f(100)), 102); } },
      ];\n`,
      'utf8',
    );
    return path;
  },
  async judge({ dimensions }) {
    // Judge hands any residual dimension to the repo.
    return Object.fromEntries(dimensions.map((d) => [d, 'repo'])) as Record<string, 'repo'>;
  },
};

describe('runPipeline (fake engine, no Codex)', () => {
  let repo: string;
  let out: string;
  let config: BenchConfig;

  beforeEach(async () => {
    repo = await mkdtemp(join(tmpdir(), '2bench-repo-'));
    out = await mkdtemp(join(tmpdir(), '2bench-out-'));
    config = await loadConfig();
    // K=2 keeps consistency measurable while halving child-process spawns
    // (each suite run against an implementation is a real tsx child).
    config = { ...config, baseline: { ...config.baseline, samplesPerSpec: 2 } };
    // Two clean modules, each large enough to clear the sampler's 30-LOC floor.
    for (const name of ['tax', 'pricing']) {
      const dir = join(repo, 'src', 'services', name);
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${name}.ts`), cleanModule(name), 'utf8');
    }
  });

  afterEach(async () => {
    await rm(repo, { recursive: true, force: true });
    await rm(out, { recursive: true, force: true });
  });

  const opts = () => ({
    outDir: out,
    offline: false,
    seed: 42,
    sampleSize: 2,
    engine: fakeEngine,
    caps: { jscpd: false, semgrep: false, gitleaks: false, eslint: false },
    now: () => '2026-07-17T00:00:00.000Z',
  });

  it('runs end-to-end and produces a complete RunResult', async () => {
    const result = await runPipeline(repo, config, opts());
    expect(result.meta.modulesSampled).toBe(2);
    expect(result.outcomes.length).toBeGreaterThan(0);
    // Repo (simple code) should beat the deliberately complex baseline on maintainability.
    const maint = result.dimensions.find((d) => d.dimension === 'maintainability')!;
    expect(maint.inUplift).toBe(true);
    expect(maint.repoScore!).toBeGreaterThan(maint.baselineScore!);
    // Consistency: repo (fixed) vs baseline stability, repo scored 1.
    const cons = result.dimensions.find((d) => d.dimension === 'consistency')!;
    expect(cons.repoScore).toBe(1);
    // D1: correctness is now EXECUTED, not judged — repo passes the shared
    // suite (3/3) while the broken baseline fails most of it.
    const corrDim = result.dimensions.find((d) => d.dimension === 'correctness')!;
    expect(corrDim.inUplift).toBe(true);
    expect(corrDim.repoScore!).toBeGreaterThan(corrDim.baselineScore!);
    const corr = result.outcomes.filter((o) => o.dimension === 'correctness');
    expect(corr.every((o) => o.method === 'deterministic')).toBe(true);
    expect(corr.every((o) => o.winner === 'repo')).toBe(true);
  }, 180_000);

  it('is deterministic: same seed → identical headline', async () => {
    const a = await runPipeline(repo, config, opts());
    // Fresh out dir to avoid cache, same seed.
    const out2 = await mkdtemp(join(tmpdir(), '2bench-out2-'));
    const b = await runPipeline(repo, config, { ...opts(), outDir: out2 });
    expect(b.headline.uplift).toEqual(a.headline.uplift);
    expect(b.headline.winRate).toEqual(a.headline.winRate);
    await rm(out2, { recursive: true, force: true });
  }, 300_000);

  it('resumes from checkpoint without re-invoking the engine', async () => {
    await runPipeline(repo, config, opts());
    let regenCalls = 0;
    const countingEngine: PipelineEngine = {
      ...fakeEngine,
      async regenerate(...args) {
        regenCalls++;
        return fakeEngine.regenerate(...args);
      },
    };
    const second = await runPipeline(repo, config, { ...opts(), engine: countingEngine });
    expect(regenCalls).toBe(0); // fully served from cache
    expect(second.meta.modulesSampled).toBe(2);
  }, 300_000);

  it('offline with no cache → repo-health only (no baseline, no outcomes)', async () => {
    const freshOut = await mkdtemp(join(tmpdir(), '2bench-offline-'));
    const result = await runPipeline(repo, config, { ...opts(), offline: true, outDir: freshOut });
    expect(result.outcomes).toHaveLength(0);
    expect(result.headline.gate.pass).toBe(false);
    await rm(freshOut, { recursive: true, force: true });
  }, 120_000);

  it('refuses to score correctness when the suite fails its own repo (D1b guard)', async () => {
    // Suite only probes the BASELINE's shape (compute), so the real repo fails
    // everything while the baseline aces it — the extracted-spec failure mode.
    const lopsidedEngine: PipelineEngine = {
      ...fakeEngine,
      async generateTests(spec, cacheDir) {
        const path = suiteCachePath(spec, cacheDir);
        await writeFile(
          path,
          `export const tests = [
            { name: 'a', run: (s, a) => a.equal(typeof s.compute, 'function') },
            { name: 'b', run: (s, a) => a.equal(s.compute(0, 0, 0, 0), 0) },
          ];\n`,
          'utf8',
        );
        return path;
      },
    };
    const freshOut = await mkdtemp(join(tmpdir(), '2bench-guard-'));
    const result = await runPipeline(repo, config, { ...opts(), engine: lopsidedEngine, outDir: freshOut });

    const corr = result.dimensions.find((d) => d.dimension === 'correctness')!;
    expect(corr.inUplift).toBe(false); // number withheld, not reported as a repo loss
    expect(result.meta.warnings.length).toBeGreaterThan(0);
    expect(result.meta.warnings[0]).toContain('correctness not scored');
    // Correctness still gets an opinion — from the judge, not the broken suite.
    const corrOutcomes = result.outcomes.filter((o) => o.dimension === 'correctness');
    expect(corrOutcomes.every((o) => o.method === 'judged')).toBe(true);
    await rm(freshOut, { recursive: true, force: true });
  }, 300_000);

  it('writes per-module manifests to the out dir', async () => {
    await runPipeline(repo, config, opts());
    const manifest = JSON.parse(
      await readFile(join(out, 'run', 'modules', 'src__services__tax', 'manifest.json'), 'utf8'),
    );
    expect(manifest.moduleId).toBe('src/services/tax');
    expect(manifest.result).toBeDefined();
  }, 300_000);
});

describe('averageDeterministic', () => {
  const s = (over: Partial<DeterministicScores>): DeterministicScores => ({
    testPassRate: null, mutationScore: null, security: null, duplication: null,
    complexityHealth: 0, lintCleanliness: null, secretCount: null, stability: null, ...over,
  });
  it('averages numeric fields and ignores nulls', () => {
    const avg = averageDeterministic([s({ complexityHealth: 0.8, security: 0.6 }), s({ complexityHealth: 0.6 })]);
    expect(avg.complexityHealth).toBeCloseTo(0.7, 10);
    expect(avg.security).toBeCloseTo(0.6, 10); // one null ignored
    expect(avg.testPassRate).toBeNull();
  });
});
