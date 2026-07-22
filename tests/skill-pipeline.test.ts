import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadBench, runSkillBench, type SkillEngine } from '../src/skill-pipeline.js';
import { buildArmPrompt } from '../src/stages/skill-run.js';
import { loadConfig } from '../src/config.js';
import type { BenchConfig, SkillBench, SkillTask } from '../src/types.js';

const SKILL = 'HOUSE RULE: always return an array of tax objects, never one combined rate.';

const bench: SkillBench = {
  name: 'test skill',
  skill: SKILL,
  tasks: [
    { id: 'tax', outputKind: 'code', prompt: 'Compute Canadian sales tax.' },
    { id: 'price', outputKind: 'code', prompt: 'Price a quote.' },
  ],
};

/** Treatment writes clean, consistent code; control writes messy, varying code. */
function makeEngine(): SkillEngine {
  return {
    async runArm(task, arm, skill, sampleIndex, workRoot) {
      const dir = join(workRoot, task.id, arm, `s${sampleIndex}`);
      await mkdir(dir, { recursive: true });
      const text =
        arm === 'treatment'
          ? `export interface TaxLine { kind: string; amount: number }\nexport function ${task.id}(a: number): TaxLine[] { return [{ kind: 'GST', amount: a * 0.05 }]; }\n`
          : // control: high complexity AND different every sample → worse on both
            `export function ${task.id}(a){\n${Array.from({ length: 20 }, (_, i) => `  if(a===${i + sampleIndex}||a>${i}&&a<${i + 2}?a:0){return ${i + sampleIndex};}`).join('\n')}\n  return ${sampleIndex};\n}\n`;
      await writeFile(join(dir, 'impl.ts'), text, 'utf8');
      expect(skill === null || skill === SKILL).toBe(true);
      return { taskId: task.id, arm, sampleIndex, dir, text, tokensUsed: 10 };
    },
    async judge({ dimensions }) {
      return Object.fromEntries(dimensions.map((d) => [d, 'repo'])) as Record<string, 'repo'>;
    },
  };
}

describe('buildArmPrompt', () => {
  const task: SkillTask = { id: 't', prompt: 'Do the thing.', outputKind: 'code' };

  it('puts the skill before the task, and omits it entirely for the control arm', () => {
    const treatment = buildArmPrompt(task, SKILL);
    const control = buildArmPrompt(task, null);
    expect(treatment.startsWith(SKILL)).toBe(true);
    expect(treatment).toContain('Do the thing.');
    expect(control).not.toContain(SKILL);
    expect(control).toContain('Do the thing.');
  });

  it('adds the files contract for code tasks only', () => {
    expect(buildArmPrompt(task, null)).toContain('"files" array');
    expect(buildArmPrompt({ ...task, outputKind: 'text' }, null)).not.toContain('"files" array');
  });
});

describe('loadBench', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), '2bench-bench-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('loads inline skill text', async () => {
    const p = join(dir, 'b.json');
    await writeFile(p, JSON.stringify(bench), 'utf8');
    const { skill, bench: loaded } = await loadBench(p);
    expect(skill).toBe(SKILL);
    expect(loaded.tasks).toHaveLength(2);
  });

  it('loads skillFile relative to the bench file', async () => {
    await writeFile(join(dir, 'skill.md'), 'FROM FILE', 'utf8');
    const p = join(dir, 'b.json');
    await writeFile(p, JSON.stringify({ ...bench, skill: undefined, skillFile: 'skill.md' }), 'utf8');
    expect((await loadBench(p)).skill).toBe('FROM FILE');
  });

  it('rejects a bench with no tasks or no skill — both are the point', async () => {
    const noTasks = join(dir, 'a.json');
    await writeFile(noTasks, JSON.stringify({ name: 'x', tasks: [] }), 'utf8');
    await expect(loadBench(noTasks)).rejects.toThrow(/tasks/);

    const noSkill = join(dir, 'c.json');
    await writeFile(noSkill, JSON.stringify({ name: 'x', tasks: bench.tasks }), 'utf8');
    await expect(loadBench(noSkill)).rejects.toThrow(/skill/);
  });
});

describe('runSkillBench', () => {
  let out: string;
  let config: BenchConfig;

  beforeEach(async () => {
    out = await mkdtemp(join(tmpdir(), '2bench-skillrun-'));
    config = await loadConfig();
    config = { ...config, baseline: { ...config.baseline, samplesPerSpec: 2 } };
  });
  afterEach(async () => {
    await rm(out, { recursive: true, force: true });
  });

  const opts = () => ({
    outDir: out,
    engine: makeEngine(),
    caps: { jscpd: false, semgrep: false, gitleaks: false, eslint: false },
    now: () => '2026-07-20T00:00:00.000Z',
  });

  it('scores the skill against plain prompting across all tasks', async () => {
    const result = await runSkillBench(bench, SKILL, config, opts());
    expect(result.meta.subject).toEqual({ kind: 'skill', name: 'test skill' });
    expect(result.meta.modulesSampled).toBe(2);
    expect(result.outcomes.length).toBeGreaterThan(0);

    // Treatment code is simple and identical across samples; control is complex
    // and varies — so the skill should win maintainability and consistency.
    const maint = result.dimensions.find((d) => d.dimension === 'maintainability')!;
    expect(maint.inUplift).toBe(true);
    expect(maint.repoScore!).toBeGreaterThan(maint.baselineScore!);
    const cons = result.dimensions.find((d) => d.dimension === 'consistency')!;
    expect(cons.repoScore!).toBeGreaterThan(cons.baselineScore!);
  }, 120_000);

  it('measures consistency on BOTH arms (not granted to one by fiat)', async () => {
    const result = await runSkillBench(bench, SKILL, config, opts());
    const cons = result.dimensions.find((d) => d.dimension === 'consistency')!;
    // Neither side is a hardcoded 1.0 — both were sampled K times and measured.
    expect(cons.baselineScore).toBeGreaterThan(0);
    expect(cons.baselineScore).toBeLessThan(1);
  }, 120_000);

  it('marks the task prompts as the spec source — no extraction bias', async () => {
    const result = await runSkillBench(bench, SKILL, config, opts());
    expect(result.meta.specSource).toBe('linear');
  }, 120_000);

  it('skips a task whose arm produced nothing, and says so', async () => {
    const emptyEngine: SkillEngine = {
      ...makeEngine(),
      async runArm(task, arm, _skill, sampleIndex, workRoot) {
        const dir = join(workRoot, task.id, arm, `s${sampleIndex}`);
        await mkdir(dir, { recursive: true });
        return { taskId: task.id, arm, sampleIndex, dir, text: '', tokensUsed: 0 };
      },
    };
    const result = await runSkillBench(bench, SKILL, config, { ...opts(), engine: emptyEngine });
    expect(result.meta.modulesSampled).toBe(0);
    expect(result.meta.warnings.length).toBe(2);
    expect(result.meta.warnings[0]).toContain('no usable output');
  }, 120_000);
});

describe('report labelling by subject', () => {
  const skillResult = (kind: 'skill' | 'codebase') => ({
    headline: {
      winRate: { estimate: 0.6, lo: 0.4, hi: 0.8, method: 'wilson' as const },
      uplift: { estimate: 0.2, lo: 0.05, hi: 0.4, method: 'cluster-bootstrap' as const },
      gate: { threshold: 0.4, pass: false },
    },
    dimensions: [
      { dimension: 'maintainability' as const, repoScore: 1, baselineScore: 0.8, uplift: 0.25, weight: 0.2, modulesMeasured: 3, inUplift: true },
    ],
    outcomes: [],
    meta: {
      repoRoot: 'my bench', modulesSampled: 3, modulesTotal: 3, specSource: 'linear' as const,
      baselineModel: 'codex-default', samplesPerSpec: 2, seed: 42,
      startedAt: 'a', finishedAt: 'b', toolVersions: {}, warnings: [],
      subject: { kind, name: 'my bench' },
    },
  });

  it('console summary speaks in tasks/skill terms for a skill run', async () => {
    const { renderConsoleSummary } = await import('../src/report/console-report.js');
    const out = renderConsoleSummary(skillResult('skill'));
    expect(out).toContain('skill vs. plain prompting');
    expect(out).toContain('tasks');
    expect(out).not.toContain('codebase vs. pure-LLM');
    expect(out).toMatch(/EARNS ITS KEEP|DOES NOT CLEAR THE BAR/);
  });

  it('html report labels the two arms as skill vs plain prompting', async () => {
    const { renderHtmlReport } = await import('../src/report/html-report.js');
    const html = renderHtmlReport(skillResult('skill'));
    expect(html).toContain('With this skill');
    expect(html).toContain('Plain prompting');
    expect(html).not.toContain('Pure-LLM baseline');
  });

  it('still uses codebase wording when there is no skill subject', async () => {
    const { renderConsoleSummary } = await import('../src/report/console-report.js');
    expect(renderConsoleSummary(skillResult('codebase'))).toContain('codebase vs. pure-LLM baseline');
  });
});
