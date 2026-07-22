import { readFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type {
  BenchConfig,
  Dimension,
  DimensionScores,
  DeterministicScores,
  PairOutcome,
  RunResult,
  SkillBench,
  SkillTask,
} from './types.js';
import { DIMENSIONS } from './types.js';
import { codexVersion } from './engine/codex.js';
import { detectCapabilities, scoreImplementation, type Capabilities } from './stages/deterministic.js';
import { judgeModule } from './stages/judge.js';
import { maintainabilityScore, moduleOutcomes } from './stages/mapping.js';
import { runArm, type Arm, type ArmOutput } from './stages/skill-run.js';
import { consistencyScore } from './scanners/consistency.js';
import { averageDeterministic } from './pipeline.js';
import { aggregateDimensions, gate, winRate } from './stats/aggregate.js';
import { clusterBootstrapCI } from './stats/bootstrap.js';

/**
 * Skill benchmarking — the same question one level up.
 *
 * The codebase scorer asks "is this code better than a zero-shot LLM's?". This
 * asks "does this SKILL beat plain prompting?" — which is the benchmark rule an
 * agency actually runs on ("skills must outperform zero-shot by ≥40%") and the
 * measurement layer a shared skill library needs.
 *
 * Everything downstream is reused unchanged: deterministic scanners, the
 * position-swapped judge, the tie-aware win rate, the paired bootstrap, the
 * gate on the CI lower bound, and both report renderers. Only the two things
 * being compared change — treatment (with skill) vs control (zero-shot) instead
 * of repo vs regenerated baseline.
 *
 * One honest improvement over the codebase case: BOTH arms are sampled K times,
 * so consistency is measured on both sides rather than granted to the delivered
 * artifact by fiat.
 */

export interface SkillEngine {
  runArm(
    task: SkillTask,
    arm: Arm,
    skill: string | null,
    sampleIndex: number,
    workRoot: string,
    model?: string,
  ): Promise<ArmOutput>;
  judge(input: {
    moduleId: string;
    spec: string;
    repoCode: string;
    baselineCode: string;
    dimensions: readonly Dimension[];
    config: BenchConfig;
    cwd: string;
  }): Promise<Partial<Record<Dimension, PairOutcome['winner']>>>;
}

export const defaultSkillEngine: SkillEngine = { runArm, judge: judgeModule };

export interface SkillPipelineOptions {
  outDir: string;
  engine?: SkillEngine;
  caps?: Capabilities;
  onProgress?: (message: string) => void;
  now?: () => string;
}

/** Load a bench file and resolve its skill text (inline or from skillFile). */
export async function loadBench(benchPath: string): Promise<{ bench: SkillBench; skill: string }> {
  const raw = JSON.parse(await readFile(benchPath, 'utf8')) as SkillBench;
  if (!raw.name || !Array.isArray(raw.tasks) || raw.tasks.length === 0) {
    throw new Error(`${benchPath}: a bench needs a "name" and a non-empty "tasks" array`);
  }
  let skill = raw.skill ?? '';
  if (raw.skillFile) {
    const p = isAbsolute(raw.skillFile) ? raw.skillFile : resolve(dirname(benchPath), raw.skillFile);
    skill = await readFile(p, 'utf8');
  }
  if (!skill.trim()) {
    throw new Error(`${benchPath}: no skill text — set "skill" or "skillFile" (that is the thing under test)`);
  }
  return { bench: raw, skill };
}

export async function runSkillBench(
  bench: SkillBench,
  skill: string,
  config: BenchConfig,
  options: SkillPipelineOptions,
): Promise<RunResult> {
  const engine = options.engine ?? defaultSkillEngine;
  const progress = options.onProgress ?? (() => {});
  const startedAt = (options.now ?? isoNow)();
  const caps = options.caps ?? (await detectCapabilities());
  const K = Math.max(2, config.baseline.samplesPerSpec); // ≥2 so consistency is measurable
  const workRoot = join(options.outDir, 'skill-run');

  const perTask: { repo: DimensionScores; baseline: DimensionScores }[] = [];
  const outcomes: PairOutcome[] = [];
  const warnings: string[] = [];

  for (const [i, task] of bench.tasks.entries()) {
    progress(`[${i + 1}/${bench.tasks.length}] ${task.id}`);
    const isCode = (task.outputKind ?? 'code') === 'code';

    progress(`  ↳ running both arms (${K} samples each)`);
    const treatment = await runSamples(engine, task, 'treatment', skill, K, workRoot, config);
    const control = await runSamples(engine, task, 'control', null, K, workRoot, config);

    if (treatment.every((o) => !o.text.trim()) || control.every((o) => !o.text.trim())) {
      warnings.push(`${task.id}: an arm produced no usable output — task skipped.`);
      continue;
    }

    const scores = {
      repo: await armDimensions(treatment, isCode, caps),
      baseline: await armDimensions(control, isCode, caps),
    };

    // Judge whatever the scanners couldn't decide (always correctness; for text
    // tasks, security/maintainability simply don't apply and stay unscored).
    const residual = DIMENSIONS.filter(
      (d) =>
        d !== 'consistency' &&
        (isCode || d === 'correctness') &&
        (scores.repo[d] === null || scores.baseline[d] === null),
    );
    let judged: Partial<Record<Dimension, PairOutcome['winner']>> = {};
    if (residual.length > 0) {
      progress(`  ↳ judging ${residual.join(', ')}`);
      judged = await engine.judge({
        moduleId: task.id,
        spec: task.prompt,
        repoCode: treatment[0]?.text ?? '',
        baselineCode: control[0]?.text ?? '',
        dimensions: residual,
        config,
        cwd: options.outDir,
      });
    }

    perTask.push(scores);
    outcomes.push(...moduleOutcomes({ moduleId: task.id, scores, judged }));
  }

  const { dimensions, perModuleCompositeUplift } = aggregateDimensions(perTask, config.weights);
  const measured = perModuleCompositeUplift
    .map((value, i) => ({ value, cluster: bench.tasks[i]?.id ?? String(i) }))
    .filter((x): x is { value: number; cluster: string } => x.value !== null);
  const uplift =
    measured.length > 0
      ? clusterBootstrapCI(measured, {
          iterations: config.stats.bootstrapIterations,
          confidence: config.stats.confidence,
          seed: config.sampling.seed,
        })
      : { estimate: 0, lo: 0, hi: 0, method: 'bootstrap-percentile' as const };

  return {
    headline: {
      winRate: winRate(outcomes, config.stats.confidence),
      uplift,
      gate: gate(uplift, config.gate.upliftThreshold),
    },
    dimensions,
    outcomes,
    meta: {
      repoRoot: bench.name,
      modulesSampled: perTask.length,
      modulesTotal: bench.tasks.length,
      specSource: 'linear', // the task prompts ARE the spec — no extraction, no circularity
      baselineModel: config.baseline.model ?? 'codex-default',
      samplesPerSpec: K,
      seed: config.sampling.seed,
      startedAt,
      finishedAt: (options.now ?? isoNow)(),
      toolVersions: await versions(),
      warnings,
      subject: { kind: 'skill', name: bench.name },
    },
  };
}

async function runSamples(
  engine: SkillEngine,
  task: SkillTask,
  arm: Arm,
  skill: string | null,
  k: number,
  workRoot: string,
  config: BenchConfig,
): Promise<ArmOutput[]> {
  const out: ArmOutput[] = [];
  for (let s = 0; s < k; s++) {
    out.push(await engine.runArm(task, arm, skill, s, workRoot, config.baseline.model ?? undefined));
  }
  return out;
}

/** Dimension scores for one arm: scanners where they apply, stability always. */
async function armDimensions(
  outputs: readonly ArmOutput[],
  isCode: boolean,
  caps: Capabilities,
): Promise<DimensionScores> {
  const consistency = consistencyScore({ sources: outputs.map((o) => o.text) });
  if (!isCode) {
    return { correctness: null, security: null, maintainability: null, consistency };
  }
  const scored: DeterministicScores[] = [];
  for (const o of outputs) {
    if (o.dir) scored.push((await scoreImplementation(o.dir, caps)).scores);
  }
  if (scored.length === 0) {
    return { correctness: null, security: null, maintainability: null, consistency };
  }
  const avg = averageDeterministic(scored);
  return {
    correctness: null, // no oracle for a free-form task — the judge decides
    security: avg.security,
    maintainability: maintainabilityScore(avg),
    consistency,
  };
}

async function versions(): Promise<Record<string, string>> {
  const v: Record<string, string> = {};
  const codex = await codexVersion();
  if (codex) v.codex = codex;
  return v;
}

function isoNow(): string {
  return new Date().toISOString();
}
