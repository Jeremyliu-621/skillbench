import type { BenchConfig, Dimension, JudgeVerdict, PairOutcome } from '../types.js';
import { codexExecJson } from '../engine/codex.js';

/**
 * Stage 5: pairwise LLM judging — used ONLY for what deterministic tools cannot
 * execute (architecture quality, readability, spec-fit of the residual).
 *
 * Bias controls are not optional (every one is evidence-forced, research-report §2.2):
 *  - PAIRWISE, never pointwise scores (~50% of pointwise code judgments tie).
 *  - POSITION SWAP: every comparison runs twice with A/B swapped; judges flip
 *    ~18% of verdicts on order alone. Disagreement between passes = tie.
 *  - HIGH REASONING EFFORT: non-reasoning judges are near-random on code.
 *  - Self-preference note: Codex judging its own baseline biases AGAINST the
 *    repo, making measured uplift a conservative lower bound. Panel judging
 *    (add Claude) is the Phase-1 hardening (HANDOFF.md task J2).
 */

export const VERDICT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['winner', 'confidence', 'reasons'],
  properties: {
    winner: { type: 'string', enum: ['A', 'B', 'tie'] },
    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
    reasons: { type: 'string' },
  },
} as const;

const DIMENSION_QUESTIONS: Record<Dimension, string> = {
  correctness:
    'Which implementation more completely and correctly satisfies the spec, including edge cases and error handling?',
  security:
    'Which implementation is more secure: input validation, injection/XSS resistance, no hardcoded secrets, safe error handling?',
  maintainability:
    'Which implementation would a professional team find easier to maintain and extend: modularity, clarity, absence of duplication, sensible structure?',
  consistency:
    'Which implementation is more deterministic and predictable: stable behavior, no hidden nondeterminism, reproducible outputs?',
};

/**
 * J1: cap the code shown to the judge. Very large modules would blow the context
 * or bury the signal; keep the head (interfaces, main logic) and tail (often
 * helpers/validation) with an explicit elision marker so the judge knows.
 * Symmetric — both sides pass through the same cap, so neither gets an edge.
 */
export const JUDGE_CODE_CHAR_CAP = 24_000;

export function truncateForJudge(code: string, cap = JUDGE_CODE_CHAR_CAP): string {
  if (code.length <= cap) return code;
  const head = Math.floor(cap * 0.6);
  const tail = cap - head;
  return (
    code.slice(0, head) +
    `\n/* … 2bench: ${code.length - cap} characters elided for judging … */\n` +
    code.slice(code.length - tail)
  );
}

export function buildJudgePrompt(spec: string, dimension: Dimension, codeA: string, codeB: string): string {
  return [
    'You are comparing two independent implementations of the same specification.',
    `Question: ${DIMENSION_QUESTIONS[dimension]}`,
    'Judge ONLY that question. If the two are genuinely close, answer "tie" — do not force a winner.',
    '',
    `## Specification\n${spec}`,
    `## Implementation A\n${truncateForJudge(codeA)}`,
    `## Implementation B\n${truncateForJudge(codeB)}`,
  ].join('\n');
}

/**
 * Reconcile the two swapped passes into one outcome.
 * Pure function — unit-tested without any LLM.
 *
 * pass1 sees (repo=A, baseline=B); pass2 sees (repo=B, baseline=A).
 */
export function reconcileSwappedVerdicts(
  pass1: JudgeVerdict,
  pass2: JudgeVerdict,
): PairOutcome['winner'] {
  const first = pass1.winner === 'A' ? 'repo' : pass1.winner === 'B' ? 'baseline' : 'tie';
  const second = pass2.winner === 'B' ? 'repo' : pass2.winner === 'A' ? 'baseline' : 'tie';
  if (first === second) return first;
  return 'tie'; // disagreement across swap = position-confounded = tie
}

/**
 * Judge a set of residual dimensions for one module and return the reconciled
 * winner per dimension. Used by the pipeline for dimensions that lack a
 * deterministic score on both sides (e.g. correctness before D1's test harness).
 */
export async function judgeModule(input: {
  moduleId: string;
  spec: string;
  repoCode: string;
  baselineCode: string;
  dimensions: readonly Dimension[];
  config: BenchConfig;
  cwd: string;
}): Promise<Partial<Record<Dimension, PairOutcome['winner']>>> {
  const out: Partial<Record<Dimension, PairOutcome['winner']>> = {};
  for (const dimension of input.dimensions) {
    const outcome = await judgePair(
      input.spec,
      input.repoCode,
      input.baselineCode,
      dimension,
      input.moduleId,
      input.config,
      input.cwd,
    );
    out[dimension] = outcome.winner;
  }
  return out;
}

// TODO: batching the four dimensions into one call per direction (cost ÷4) is
// possible but must first be verified against unbatched verdicts on real modules.
export async function judgePair(
  spec: string,
  repoCode: string,
  baselineCode: string,
  dimension: Dimension,
  moduleId: string,
  config: BenchConfig,
  cwd: string,
): Promise<PairOutcome> {
  const opts = { cwd, sandbox: 'read-only' as const, reasoningEffort: config.judge.reasoningEffort };
  const { value: pass1 } = await codexExecJson<JudgeVerdict>(
    buildJudgePrompt(spec, dimension, repoCode, baselineCode),
    VERDICT_SCHEMA,
    opts,
  );
  const { value: pass2 } = await codexExecJson<JudgeVerdict>(
    buildJudgePrompt(spec, dimension, baselineCode, repoCode),
    VERDICT_SCHEMA,
    opts,
  );
  return {
    moduleId,
    dimension,
    winner: reconcileSwappedVerdicts(pass1, pass2),
    method: 'judged',
    detail: `pass1=${pass1.winner}(${pass1.confidence}) pass2=${pass2.winner}(${pass2.confidence})`,
  };
}
