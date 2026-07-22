import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  BaselineCandidate,
  BenchConfig,
  Dimension,
  DimensionScores,
  DeterministicScores,
  ModuleInfo,
  ModuleSpec,
  PairOutcome,
  RunResult,
} from './types.js';
import { DIMENSIONS } from './types.js';
import { codexVersion } from './engine/codex.js';
import { inventory, sampleModules } from './stages/inventory.js';
import {
  detectCapabilities,
  detectTools,
  scoreImplementation,
  type Capabilities,
} from './stages/deterministic.js';
import { extractSpec, loadExternalSpec, specLeakage } from './stages/spec-extract.js';
import { regenerateBaseline } from './stages/regenerate.js';
import { generateTestSuite, isFidelitySuspect, runTestSuite, suiteCachePath } from './stages/testgen.js';
import { judgeModule } from './stages/judge.js';
import { moduleDimensionScores, moduleOutcomes } from './stages/mapping.js';
import { readCandidateSources, scoreBaselineConsistency } from './scanners/consistency.js';
import { aggregateDimensions, gate, winRate } from './stats/aggregate.js';
import { clusterBootstrapCI } from './stats/bootstrap.js';

/**
 * Stage 6: pipeline orchestration.
 *
 * The Codex-backed stages are injected via `PipelineEngine` so the whole thing
 * is testable with a fake engine (no Codex calls, no usage-window burn). Each
 * module checkpoints to disk (spec, candidate dirs, computed result) so an
 * interrupted run resumes instead of restarting — essential given Codex's
 * 5-hour rolling subscription window.
 *
 * Modes:
 *  - full: extract spec → regenerate baseline → score both sides → judge
 *    residual dims → map → aggregate.
 *  - offline: zero Codex calls. Reuses cached specs/candidates from a prior run
 *    if present (→ full comparison); otherwise emits repo-health only (no uplift).
 */

export interface PipelineEngine {
  extractSpec(module: ModuleInfo, repoRoot: string): Promise<ModuleSpec>;
  regenerate(spec: ModuleSpec, workRoot: string, config: BenchConfig): Promise<BaselineCandidate[]>;
  /** D1: produce (or reuse cached) shared test-suite file for a spec. */
  generateTests(spec: ModuleSpec, cacheDir: string): Promise<string>;
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

export const defaultEngine: PipelineEngine = {
  extractSpec,
  regenerate: regenerateBaseline,
  generateTests: generateTestSuite,
  judge: judgeModule,
};

export interface PipelineOptions {
  outDir: string;
  offline: boolean;
  seed?: number;
  sampleSize?: number;
  engine?: PipelineEngine;
  /** Skip tool auto-detection (hermetic tests, or to force a scanner set). */
  caps?: Capabilities;
  /** X1: directory of externally-authored specs (<module-key>.json → source 'linear'). */
  specsDir?: string;
  onProgress?: (message: string) => void;
  /** Injectable clock so runs are reproducible in tests (Date is not available in some contexts). */
  now?: () => string;
}

interface ModuleResult {
  moduleId: string;
  repo: DimensionScores;
  baseline: DimensionScores;
  outcomes: PairOutcome[];
  specSource: ModuleSpec['source'] | 'none';
  baselineCandidates: number;
  /** Measurement caveats surfaced to the reports (never silently swallowed). */
  warnings?: string[];
}

interface ModuleManifest {
  moduleId: string;
  candidateDirs: string[];
  result?: ModuleResult;
}

export async function runPipeline(
  repoRoot: string,
  config: BenchConfig,
  options: PipelineOptions,
): Promise<RunResult> {
  const engine = options.engine ?? defaultEngine;
  const seed = options.seed ?? config.sampling.seed;
  const progress = options.onProgress ?? (() => {});
  const startedAt = (options.now ?? isoNow)();

  const caps = options.caps ?? (await detectCapabilities());
  progress(`scanners: ${describeCaps(caps)}`);

  const inv = await inventory(repoRoot);
  const size =
    options.sampleSize ??
    clamp(Math.round(inv.modules.length / 4), config.sampling.minModules, config.sampling.maxModules);
  const sample = sampleModules(inv.modules, { size, seed });
  progress(`inventory: ${inv.modules.length} modules, ${inv.totalLoc} LOC → sampling ${sample.length}`);

  const runDir = join(options.outDir, 'run');
  const moduleResults: ModuleResult[] = [];
  for (const [i, module] of sample.entries()) {
    progress(`[${i + 1}/${sample.length}] ${module.id}`);
    const result = await processModule(
      module, repoRoot, config, caps, engine, runDir, options.offline, progress, options.specsDir,
    );
    moduleResults.push(result);
  }

  const perModule = moduleResults.map((r) => ({ repo: r.repo, baseline: r.baseline }));
  const outcomes = moduleResults.flatMap((r) => r.outcomes);
  const { dimensions, perModuleCompositeUplift } = aggregateDimensions(perModule, config.weights);

  const winRateCI = winRate(outcomes, config.stats.confidence);
  // Headline uplift: paired per-module bootstrap, CLUSTER-aware — modules from
  // one subsystem are correlated, and naive resampling understates uncertainty
  // (research-report §2.5). Falls back to the plain bootstrap automatically
  // when there's no real clustering.
  const clusteredUplifts = perModuleCompositeUplift
    .map((value, i) => ({ value, cluster: sample[i]?.subsystem ?? '(unknown)' }))
    .filter((x): x is { value: number; cluster: string } => x.value !== null);
  const uplift =
    clusteredUplifts.length > 0
      ? clusterBootstrapCI(clusteredUplifts, {
          iterations: config.stats.bootstrapIterations,
          confidence: config.stats.confidence,
          seed,
        })
      : { estimate: 0, lo: 0, hi: 0, method: 'bootstrap-percentile' as const };

  const toolVersions = await gatherToolVersions(caps);

  return {
    headline: {
      winRate: winRateCI,
      uplift,
      gate: gate(uplift, config.gate.upliftThreshold),
    },
    dimensions,
    outcomes,
    meta: {
      repoRoot,
      modulesSampled: sample.length,
      modulesTotal: inv.modules.length,
      specSource: summarizeSpecSource(moduleResults),
      baselineModel: config.baseline.model ?? 'codex-default',
      samplesPerSpec: config.baseline.samplesPerSpec,
      seed,
      startedAt,
      finishedAt: (options.now ?? isoNow)(),
      toolVersions,
      warnings: moduleResults.flatMap((r) => r.warnings ?? []),
    },
  };
}

function pct(x: number | null): string {
  return x === null ? 'n/a' : `${Math.round(x * 100)}%`;
}

async function processModule(
  module: ModuleInfo,
  repoRoot: string,
  config: BenchConfig,
  caps: Capabilities,
  engine: PipelineEngine,
  runDir: string,
  offline: boolean,
  progress: (m: string) => void,
  specsDir?: string,
): Promise<ModuleResult> {
  const moduleDir = join(runDir, 'modules', keyOf(module.id));
  await mkdir(moduleDir, { recursive: true });
  const warnings: string[] = [];

  const cached = await readManifest(moduleDir);
  if (cached?.result) {
    progress(`  ↳ cached`);
    return cached.result;
  }

  // Repo side: always scored deterministically.
  const repoDet = (await scoreImplementation(module.rootDir, caps)).scores;

  // Spec + baseline candidates (from cache, else engine unless offline).
  const spec = await loadOrExtractSpec(module, repoRoot, moduleDir, engine, offline, progress, specsDir);
  const candidates = await loadOrRegenerate(spec, moduleDir, config, engine, offline, cached, progress);

  // D1: shared spec-derived test suite. Suite generation needs Codex (skipped
  // offline unless the cache already has it); RUNNING the suite is deterministic
  // and free, so it happens even offline when a cached suite exists.
  const suitePath = await loadOrGenerateSuite(spec, moduleDir, engine, offline, progress);
  if (suitePath && spec) {
    const repoRun = await runTestSuite(module.rootDir, suitePath);
    repoDet.testPassRate = repoRun?.passRate ?? null;
    if (repoRun === null) progress(`  ↳ repo-side suite run unusable (import/alias failure) — correctness falls back to judge`);
  }

  let result: ModuleResult;
  if (candidates.length === 0) {
    // No baseline available → repo-health only, no head-to-head.
    const repoDims = moduleDimensionScores({ repoDet, baselineDet: repoDet, baselineStability: null }).repo;
    result = {
      moduleId: module.id,
      repo: { ...repoDims, consistency: null },
      baseline: emptyDimensions(),
      outcomes: [],
      specSource: spec?.source ?? 'none',
      baselineCandidates: 0,
      warnings,
    };
  } else {
    const candidateScores = await Promise.all(
      candidates.map(async (c) => (await scoreImplementation(c.dir, caps)).scores),
    );
    // D1: run the shared suite against every candidate; per-candidate pass rates
    // feed both the baseline's correctness and its behavioral stability.
    let candidatePassRates: (number | null)[] = [];
    if (suitePath) {
      candidatePassRates = await mapSequential(candidates, async (c) => {
        const run = await runTestSuite(c.dir, suitePath);
        return run?.passRate ?? null;
      });
      candidateScores.forEach((s, i) => (s.testPassRate = candidatePassRates[i] ?? null));

      // D1b: refuse to report a correctness number the suite can't support.
      const measured = candidatePassRates.filter((r): r is number => r !== null);
      const baselineMean = measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : null;
      if (
        spec &&
        isFidelitySuspect({
          specSource: spec.source,
          repoPassRate: repoDet.testPassRate,
          baselinePassRate: baselineMean,
        })
      ) {
        warnings.push(
          `${module.id}: correctness not scored — the spec was extracted from code, and the repo passed only ` +
            `${pct(repoDet.testPassRate)} of the derived suite vs the baseline's ${pct(baselineMean)}. ` +
            `That gap indicates the suite is testing the extracted paraphrase rather than the real contract. ` +
            `Supply an authored spec via --specs to measure correctness for this module.`,
        );
        progress(`  ↳ ⚠ suite fidelity suspect — correctness falls back to judge`);
        repoDet.testPassRate = null;
        candidateScores.forEach((s) => (s.testPassRate = null));
      }
    }
    const baselineDet = averageDeterministic(candidateScores);
    const baselineStability = await scoreBaselineConsistency(candidates, candidatePassRates);
    const scores = moduleDimensionScores({ repoDet, baselineDet, baselineStability });

    // Judge only residual dimensions (no deterministic score on both sides),
    // excluding consistency (handled deterministically or left unmeasured).
    const residual = DIMENSIONS.filter(
      (d) => d !== 'consistency' && (scores.repo[d] === null || scores.baseline[d] === null),
    );
    let judged: Partial<Record<Dimension, PairOutcome['winner']>> = {};
    if (!offline && spec && residual.length > 0) {
      progress(`  ↳ judging ${residual.join(', ')}`);
      judged = await engine.judge({
        moduleId: module.id,
        spec: renderSpec(spec),
        repoCode: await readCandidateSources(module.rootDir),
        baselineCode: await readCandidateSources(candidates[0]!.dir),
        dimensions: residual,
        config,
        cwd: repoRoot,
      });
    }

    result = {
      moduleId: module.id,
      repo: scores.repo,
      baseline: scores.baseline,
      outcomes: moduleOutcomes({ moduleId: module.id, scores, judged }),
      specSource: spec?.source ?? 'none',
      baselineCandidates: candidates.length,
      warnings,
    };
  }

  await writeManifest(moduleDir, {
    moduleId: module.id,
    candidateDirs: candidates.map((c) => c.dir),
    result,
  });
  return result;
}

async function loadOrExtractSpec(
  module: ModuleInfo,
  repoRoot: string,
  moduleDir: string,
  engine: PipelineEngine,
  offline: boolean,
  progress: (m: string) => void,
  specsDir?: string,
): Promise<ModuleSpec | null> {
  // Priority: external spec (honest, zero circularity) > cached > extraction.
  if (specsDir) {
    const external = await loadExternalSpec(module, specsDir);
    if (external) {
      progress(`  ↳ using external spec (linear)`);
      return external;
    }
  }
  const specPath = join(moduleDir, 'spec.json');
  const cached = await readJson<ModuleSpec>(specPath);
  if (cached) return cached;
  if (offline) return null;
  progress(`  ↳ extracting spec`);
  const spec = await engine.extractSpec(module, repoRoot);
  const leakage = specLeakage(spec, await readCandidateSources(module.rootDir));
  if (leakage > 0.5) {
    progress(
      `  ↳ ⚠ extracted spec echoes ${Math.round(leakage * 100)}% of the code's identifiers — implementation leakage; prefer an external spec for this module`,
    );
  }
  await writeFile(specPath, JSON.stringify(spec, null, 2), 'utf8');
  return spec;
}

/** Suite from cache (hash of spec) if present; else generated via the engine
 *  unless offline. Returns null when no suite is obtainable. */
async function loadOrGenerateSuite(
  spec: ModuleSpec | null,
  moduleDir: string,
  engine: PipelineEngine,
  offline: boolean,
  progress: (m: string) => void,
): Promise<string | null> {
  if (!spec) return null;
  const cached = suiteCachePath(spec, moduleDir);
  if (existsSync(cached)) return cached;
  if (offline) return null;
  progress(`  ↳ generating shared test suite`);
  try {
    return await engine.generateTests(spec, moduleDir);
  } catch {
    progress(`  ↳ suite generation failed — correctness falls back to judge`);
    return null;
  }
}

/** Find previously regenerated candidate dirs: <moduleDir>/baseline/<key>/p<N>-s<N>. */
async function discoverCandidateDirs(moduleDir: string): Promise<string[]> {
  const root = join(moduleDir, 'baseline');
  const found: string[] = [];
  for (const keyDir of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!keyDir.isDirectory()) continue;
    const inner = join(root, keyDir.name);
    for (const cand of await readdir(inner, { withFileTypes: true }).catch(() => [])) {
      if (cand.isDirectory() && /^p\d+-s\d+$/.test(cand.name)) found.push(join(inner, cand.name));
    }
  }
  return found.sort();
}

async function mapSequential<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (const item of items) out.push(await fn(item));
  return out;
}

async function loadOrRegenerate(
  spec: ModuleSpec | null,
  moduleDir: string,
  config: BenchConfig,
  engine: PipelineEngine,
  offline: boolean,
  cached: ModuleManifest | null,
  progress: (m: string) => void,
): Promise<BaselineCandidate[]> {
  const known = cached?.candidateDirs?.length
    ? cached.candidateDirs
    : // Manifest missing or lost? Recover the candidates already on disk rather
      // than regenerating them — they cost real Codex calls.
      await discoverCandidateDirs(moduleDir);
  if (known.length) {
    return known.map((dir, i) => ({
      moduleId: cached?.moduleId ?? spec?.moduleId ?? '',
      dir,
      sampleIndex: i,
      promptIndex: 0,
      tokensUsed: 0,
    }));
  }
  if (offline || !spec) return [];
  progress(`  ↳ regenerating baseline (${config.baseline.promptParaphrases}×${config.baseline.samplesPerSpec})`);
  return engine.regenerate(spec, moduleDir, config);
}

// --- helpers ---------------------------------------------------------------

export function averageDeterministic(list: readonly DeterministicScores[]): DeterministicScores {
  const keys = Object.keys(list[0] ?? {}) as (keyof DeterministicScores)[];
  const out = {} as DeterministicScores;
  for (const k of keys) {
    const vals = list.map((d) => d[k]).filter((v): v is number => v !== null);
    out[k] = vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  return out;
}

function emptyDimensions(): DimensionScores {
  return { correctness: null, security: null, maintainability: null, consistency: null };
}

export function renderSpec(spec: ModuleSpec): string {
  return [
    `# ${spec.title}`,
    '## Requirements',
    ...spec.requirements.map((r) => `- ${r}`),
    '## Public interfaces',
    ...spec.interfaces.map((i) => `- ${i}`),
    '## Constraints',
    ...spec.constraints.map((c) => `- ${c}`),
  ].join('\n');
}

function summarizeSpecSource(results: readonly ModuleResult[]): 'linear' | 'extracted' | 'mixed' {
  const sources = new Set(results.map((r) => r.specSource).filter((s) => s !== 'none'));
  if (sources.size === 0) return 'extracted';
  if (sources.size === 1) return [...sources][0] as 'linear' | 'extracted';
  return 'mixed';
}

async function gatherToolVersions(caps: Capabilities): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  const codex = await codexVersion();
  if (codex) versions.codex = codex;
  // Only version-probe tools that are actually available (avoids slow npx probes
  // for absent scanners and keeps hermetic runs from touching the network).
  if (Object.values(caps).some(Boolean)) {
    for (const t of await detectTools()) {
      if (t.found && t.version) versions[t.name] = t.version;
    }
  }
  return versions;
}

function describeCaps(caps: Capabilities): string {
  return Object.entries(caps)
    .map(([k, v]) => `${k}${v ? '✓' : '✗'}`)
    .join(' ');
}

function keyOf(moduleId: string): string {
  return moduleId.replace(/[\\/]/g, '__') || '_root';
}

async function readManifest(moduleDir: string): Promise<ModuleManifest | null> {
  return readJson<ModuleManifest>(join(moduleDir, 'manifest.json'));
}

async function writeManifest(moduleDir: string, manifest: ModuleManifest): Promise<void> {
  await writeFile(join(moduleDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
}

async function readJson<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as T;
  } catch {
    return null;
  }
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, x));
}

function isoNow(): string {
  // Note: Date is available in the CLI runtime; tests pass an explicit `now`.
  return new Date().toISOString();
}
