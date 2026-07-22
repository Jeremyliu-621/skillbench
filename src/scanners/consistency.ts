import { readFile } from 'node:fs/promises';
import type { BaselineCandidate } from '../types.js';
import { clamp01 } from './normalize.js';
import { collectSourceFiles } from './complexity.js';

/**
 * Consistency / determinism dimension.
 *
 * Vanilla LLM code generation is non-deterministic — the same spec yields
 * different code across runs — and that instability is itself a measurable
 * quality weakness (and one that mature agency pipelines already track: such a pipeline went from
 * 2/10 → 10/10 identical regenerations as it matured). We measure it two ways
 * over the K baseline candidates and combine what's available:
 *   1. code similarity — mean pairwise cosine over token-frequency vectors;
 *   2. behavioral stability — agreement of test pass rates across candidates
 *      (available once D1 populates testPassRate).
 *
 * The repo side has no natural K-sample analogue, so it stays null unless a
 * regeneration log is supplied (repoConsistencyFromLog). Never fabricate it.
 */

/** Tokenize source into a bag of code tokens (identifiers, numbers, punctuation),
 *  ignoring whitespace. Comments are left in — divergent comments are a real part
 *  of regeneration variance. Deterministic. */
export function tokenize(source: string): string[] {
  return source.match(/[A-Za-z_$][\w$]*|\d+(?:\.\d+)?|[^\s\w]/g) ?? [];
}

/** Content tokens only: identifiers, keywords, numbers — drops pure punctuation.
 *  Punctuation (`(){};,`) is near-constant across any two code files and would
 *  otherwise put a ~0.6 similarity floor under even unrelated code, compressing
 *  the discriminative range. Used for module-level similarity. */
export function contentTokens(source: string): string[] {
  return tokenize(source).filter((t) => /^[A-Za-z_$\d]/.test(t));
}

export function termFrequency(tokens: string[]): Map<string, number> {
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  return tf;
}

/** Cosine similarity ∈ [0,1] between two token-frequency vectors. */
export function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  for (const [t, av] of a) dot += av * (b.get(t) ?? 0);
  const magA = Math.sqrt([...a.values()].reduce((s, v) => s + v * v, 0));
  const magB = Math.sqrt([...b.values()].reduce((s, v) => s + v * v, 0));
  if (magA === 0 || magB === 0) return magA === magB ? 1 : 0;
  return dot / (magA * magB);
}

/** Mean pairwise code similarity across K sources ∈ [0,1]. 1 = identical outputs. */
export function meanPairwiseSimilarity(sources: readonly string[]): number {
  if (sources.length < 2) return 1; // a single sample is trivially "stable"
  const vectors = sources.map((s) => termFrequency(contentTokens(s)));
  let total = 0;
  let pairs = 0;
  for (let i = 0; i < vectors.length; i++) {
    for (let j = i + 1; j < vectors.length; j++) {
      total += cosineSimilarity(vectors[i]!, vectors[j]!);
      pairs++;
    }
  }
  return pairs === 0 ? 1 : total / pairs;
}

/** Behavioral stability from test pass rates: 1 when all equal, 0 when maximally
 *  spread (population stddev of a [0,1] variable maxes at 0.5). */
export function passRateStability(rates: readonly (number | null)[]): number | null {
  const vals = rates.filter((r): r is number => r !== null);
  if (vals.length < 2) return null;
  const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
  const variance = vals.reduce((s, v) => s + (v - mean) ** 2, 0) / vals.length;
  return clamp01(1 - 2 * Math.sqrt(variance));
}

/** Combine the available signals into one consistency score ∈ [0,1]. */
export function consistencyScore(input: {
  sources: readonly string[];
  passRates?: readonly (number | null)[];
}): number {
  const sim = meanPairwiseSimilarity(input.sources);
  const beh = input.passRates ? passRateStability(input.passRates) : null;
  return beh === null ? sim : (sim + beh) / 2;
}

/** Read every source file in a candidate dir into one concatenated string
 *  (files sorted for determinism). */
export async function readCandidateSources(dir: string): Promise<string> {
  const files = (await collectSourceFiles(dir)).sort();
  const parts = await Promise.all(files.map((f) => readFile(f, 'utf8').catch(() => '')));
  return parts.join('\n');
}

/** Stage entry: consistency of the K baseline candidates for one module. */
export async function scoreBaselineConsistency(
  candidates: readonly BaselineCandidate[],
  passRates?: readonly (number | null)[],
): Promise<number | null> {
  if (candidates.length < 2) return null; // need ≥2 regenerations to measure spread
  const sources = await Promise.all(candidates.map((c) => readCandidateSources(c.dir)));
  return consistencyScore({ sources, passRates });
}
