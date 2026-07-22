/**
 * Core data shapes for the 2bench pipeline.
 *
 * Pipeline: inventory → sample → spec-extract → regenerate → deterministic scoring
 *           → pairwise judging → aggregate → report.
 * See docs/architecture.md for how these flow between stages.
 */

export type Dimension = 'correctness' | 'security' | 'maintainability' | 'consistency';

export const DIMENSIONS: readonly Dimension[] = [
  'correctness',
  'security',
  'maintainability',
  'consistency',
] as const;

/** A unit of comparison: a directory of source files with one responsibility. */
export interface ModuleInfo {
  /** Stable id: repo-relative dir path, posix separators. */
  id: string;
  name: string;
  /** Absolute path to the module's root directory. */
  rootDir: string;
  /** Repo-relative source file paths (posix). */
  files: string[];
  loc: number;
  /** First path segment under the repo root — used for stratified sampling and clustered stats. */
  subsystem: string;
  kind: 'route' | 'service' | 'ui' | 'lib';
}

export interface RepoInventory {
  repoRoot: string;
  modules: ModuleInfo[];
  totalLoc: number;
}

/** Business-level spec used to regenerate a module. Information parity matters:
 *  prefer real tickets ('linear'); code-derived specs are a flagged fallback
 *  (threat: spec circularity — see docs/research-report.md §5). */
export interface ModuleSpec {
  moduleId: string;
  title: string;
  /** What the module must do, at business-logic altitude (no implementation detail). */
  requirements: string[];
  /** Public interface the rest of the app relies on (function signatures / endpoints). */
  interfaces: string[];
  constraints: string[];
  source: 'linear' | 'extracted';
}

/** One generated implementation of a spec (the vanilla-LLM baseline side). */
export interface BaselineCandidate {
  moduleId: string;
  /** Which regeneration sample (0..K-1). */
  sampleIndex: number;
  /** Which prompt paraphrase produced it (0..P-1). */
  promptIndex: number;
  /** Absolute path to the scratch dir holding the generated code. */
  dir: string;
  tokensUsed: number;
}

/** Deterministic (tool-derived, reproducible) scores for one implementation.
 *  All values normalized to [0, 1] where 1 = best, so uplift math is uniform. */
export interface DeterministicScores {
  /** Share of the shared spec-derived test suite passing. */
  testPassRate: number | null;
  /** Mutation score (Stryker). Weighted above raw coverage per Just et al. */
  mutationScore: number | null;
  /** 1 − normalized weighted security-finding density (CWE-class weighted). */
  security: number | null;
  /** 1 − duplication share (jscpd). */
  duplication: number | null;
  /** Share of code NOT in unhealthy-complexity files (distribution, never mean). */
  complexityHealth: number | null;
  /** 1 − normalized lint-error density. */
  lintCleanliness: number | null;
  /** Count of hardcoded secrets found (not normalized — any > 0 is reported loudly). */
  secretCount: number | null;
  /** Stability across K regenerations (baseline) or regeneration runs (repo pipeline). */
  stability: number | null;
}

export type Contender = 'repo' | 'baseline';

/** Outcome of one position-swapped pairwise comparison on one dimension. */
export interface PairOutcome {
  moduleId: string;
  dimension: Dimension;
  winner: Contender | 'tie';
  /** How it was decided: executed tests/tools ('deterministic') or LLM judge ('judged'). */
  method: 'deterministic' | 'judged';
  detail?: string;
}

/** Raw single-direction judge verdict (before swap reconciliation). */
export interface JudgeVerdict {
  winner: 'A' | 'B' | 'tie';
  confidence: 'low' | 'medium' | 'high';
  reasons: string;
}

export interface ConfidenceInterval {
  estimate: number;
  lo: number;
  hi: number;
  method: 'wilson' | 'bootstrap-percentile' | 'cluster-bootstrap';
}

/** Per-side scores on the four dimensions for one module. null = not measured. */
export interface DimensionScores {
  correctness: number | null;
  security: number | null;
  maintainability: number | null;
  consistency: number | null;
}

export interface DimensionResult {
  dimension: Dimension;
  /** null = not measured. Never NaN: JSON has no NaN, and a round-tripped NaN
   *  becomes null, which downstream consumers would misread as a real zero. */
  repoScore: number | null;
  baselineScore: number | null;
  /** (repo − baseline) / baseline */
  uplift: number;
  weight: number;
  /** How many sampled modules had a numeric score for this dimension on both sides. */
  modulesMeasured: number;
  /** Whether this dimension entered the uplift % (needs ≥1 measured module). */
  inUplift: boolean;
}

/** One task in a skill benchmark: a prompt the skill is supposed to help with. */
export interface SkillTask {
  id: string;
  prompt: string;
  /** 'code' → outputs are files we can scan and execute; 'text' → judged only. */
  outputKind?: 'code' | 'text';
}

/**
 * A skill benchmark: does this custom skill actually beat plain prompting?
 * Same question as the codebase scorer, one level up — this is the measurement
 * layer for a skill library (an agency's "skills must beat zero-shot by ≥40%").
 */
export interface SkillBench {
  name: string;
  /** The skill/context under test, inline… */
  skill?: string;
  /** …or a file holding it, resolved relative to the bench file. */
  skillFile?: string;
  tasks: SkillTask[];
}

/** What was measured — lets the reports label the two sides correctly. */
export interface RunSubject {
  kind: 'codebase' | 'skill';
  name: string;
}

export interface RunResult {
  headline: {
    /** Share of head-to-head comparisons won (ties = ½). */
    winRate: ConfidenceInterval;
    /** Weighted relative uplift — the “X% better” number and the 40%-rule input. */
    uplift: ConfidenceInterval;
    gate: { threshold: number; pass: boolean };
  };
  dimensions: DimensionResult[];
  outcomes: PairOutcome[];
  meta: {
    repoRoot: string;
    modulesSampled: number;
    modulesTotal: number;
    specSource: 'linear' | 'extracted' | 'mixed';
    baselineModel: string;
    samplesPerSpec: number;
    seed: number;
    startedAt: string;
    finishedAt: string;
    toolVersions: Record<string, string>;
    /** Measurement caveats (e.g. a dimension we refused to score). Always shown. */
    warnings: string[];
    /** Defaults to a codebase run when absent. */
    subject?: RunSubject;
  };
}

export interface BenchConfig {
  gate: { upliftThreshold: number };
  weights: Record<Dimension, number>;
  sampling: { minModules: number; maxModules: number; seed: number };
  baseline: { samplesPerSpec: number; promptParaphrases: number; model: string | null };
  judge: { reasoningEffort: 'low' | 'medium' | 'high'; positionSwap: boolean; disagreementIsTie: boolean };
  stats: { bootstrapIterations: number; confidence: number };
}
