import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ModuleSpec } from '../types.js';
import { codexExecJson } from '../engine/codex.js';
import { runProcess } from '../engine/proc.js';

/**
 * D1: shared spec-derived test suite — the executed-correctness dimension.
 *
 * One suite per module, generated FROM THE SPEC ONLY (never from either
 * implementation — the suite is the differential oracle; the repo's code is not
 * assumed correct, research §2.1). The same suite runs against the repo module
 * and every baseline candidate via the subject-merging child runner
 * (harness/run-tests.ts), so no side gets a friendlier harness.
 *
 * Augmented inputs are demanded in the prompt (boundary values, error paths,
 * invalid input): thin test suites overstate LLM correctness by up to ~29%.
 * Suites are cached by spec hash — reruns and the offline mode reuse them.
 */

const SUITE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['content'],
  properties: {
    content: { type: 'string', description: 'Complete TypeScript source of the test file.' },
  },
} as const;

const TESTGEN_PROMPT = (specText: string): string => `Write a thorough test suite for a module implementing the specification below.

Hard rules for the test file:
- Export exactly: \`export const tests: { name: string; run: (subject: any, assert: any) => void | Promise<void> }[]\`
- \`subject\` holds the module's exported functions/values by name (e.g. \`subject.taxFor(...)\`). Probe defensively: if an expected function is missing, the assertion failure message should say so.
- \`assert\` is node:assert/strict (assert.equal, assert.deepEqual, assert.throws, assert.ok, ...). Import NOTHING — no import statements at all.
- 12 to 25 tests. Cover: normal cases for every requirement; boundary values (zero, negative, empty, largest sensible); every error/validation behavior in the constraints (use assert.throws); any multi-item shapes the spec calls for.
- Deterministic only: no Date.now, no randomness, no timers, no I/O.
- For floating-point money math, compare after rounding to 2 decimals rather than exact equality on long decimals.

Specification:
${specText}`;

/** Generate (or reuse cached) shared suite for a spec. Returns the file path. */
export async function generateTestSuite(spec: ModuleSpec, cacheDir: string): Promise<string> {
  const path = suiteCachePath(spec, cacheDir);
  if (existsSync(path)) return path;
  const { value } = await codexExecJson<{ content: string }>(
    TESTGEN_PROMPT(renderSpecForTests(spec)),
    SUITE_SCHEMA,
    { cwd: cacheDir, sandbox: 'read-only', reasoningEffort: 'high' },
  );
  await writeFile(path, value.content, 'utf8');
  return path;
}

/** Cache path is a pure function of the spec content (invariant 1: determinism). */
export function suiteCachePath(spec: ModuleSpec, cacheDir: string): string {
  const hash = createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 8);
  return join(cacheDir, `tests-${hash}.ts`);
}

export interface SuiteRun {
  passRate: number;
  total: number;
  passed: number;
  failedImports: number;
  failures: { name: string; error: string }[];
}

/**
 * Run a suite against one implementation dir. Returns null (not 0) when the
 * result can't be trusted: runner crashed, no tests, or NOTHING imported —
 * an all-imports-failed run usually means unresolvable path aliases or missing
 * deps, not "every behavior is wrong" (invariant 9: degrade loudly).
 */
export async function runTestSuite(implDir: string, testFile: string): Promise<SuiteRun | null> {
  const runner = resolveRunner();
  // Invoke tsx's CLI directly under the current node binary: no npx resolution
  // (~2s/spawn on Windows), no .cmd shim, no shell needed. tsx is a regular
  // dependency, so this works for the built CLI too.
  const { stdout, timedOut } = await runProcess(
    process.execPath,
    [tsxCliPath(), runner, implDir, testFile],
    { timeoutMs: 90_000, cwd: packageRoot() },
  );
  if (timedOut) return null;

  const line = stdout.split('\n').reverse().find((l) => l.startsWith('2BENCH_RESULT '));
  if (!line) return null;
  let parsed: {
    total?: number; passed?: number; importedFiles?: number;
    failedImports?: unknown[]; failures?: { name: string; error: string }[]; fatal?: string;
  };
  try {
    parsed = JSON.parse(line.slice('2BENCH_RESULT '.length));
  } catch {
    return null;
  }
  if (parsed.fatal !== undefined) return null;
  const total = parsed.total ?? 0;
  if (total === 0 || (parsed.importedFiles ?? 0) === 0) return null;
  const passed = parsed.passed ?? 0;
  return {
    passRate: passed / total,
    total,
    passed,
    failedImports: parsed.failedImports?.length ?? 0,
    failures: parsed.failures ?? [],
  };
}

/**
 * D1b: suite-fidelity guard.
 *
 * When a spec was EXTRACTED from code rather than authored, the generated suite
 * and the regenerated baseline both descend from the same lossy paraphrase — so
 * they agree with each other, while the real implementation (richer types, side
 * effects, behavior the paraphrase never captured) fails tests that check the
 * paraphrase rather than the contract. The symptom is unmistakable: the repo
 * scores far below its own derived suite while the baseline aces it.
 *
 * That is a measurement failure, not a quality signal, so we refuse to report
 * the number: correctness falls back to the judge and the report says why.
 * Authored specs (`--specs`) are exempt — there the suite tests the contract
 * both sides genuinely owed. Observed on the 2026-07-17 self-run (repo 0.12 vs
 * baseline 0.98 on a module whose real interface is a rich internal type).
 */
/**
 * Two conditions, both interpretable — deliberately not a single tuned number:
 *  1. the suite demonstrably WORKS (the baseline passes ≥ BASELINE_HEALTHY), so
 *     we can't blame a broken suite for everyone; and
 *  2. the repo nonetheless trails it badly (< FIDELITY_RATIO of the baseline's
 *     rate). Shipped, working code does not fail a *faithful* spec suite that a
 *     zero-shot rewrite aces — that asymmetry indicts the spec, not the code.
 *
 * Calibrated against the 2026-07-17 self-run, where both flagged modules
 * (`src/report` 0.12 vs 0.98, `src/engine` 0.41 vs 0.82) are infrastructure whose
 * real contracts — Windows shell quoting, tree-kill, rich internal types — no
 * extracted paraphrase captures. Authored specs make the whole check moot.
 */
export const FIDELITY_RATIO = 0.7;
export const BASELINE_HEALTHY = 0.7;

export function isFidelitySuspect(input: {
  specSource: ModuleSpec['source'];
  repoPassRate: number | null;
  baselinePassRate: number | null;
  ratio?: number;
}): boolean {
  if (input.specSource !== 'extracted') return false;
  if (input.repoPassRate === null || input.baselinePassRate === null) return false;
  if (input.baselinePassRate < BASELINE_HEALTHY) return false;
  return input.repoPassRate < (input.ratio ?? FIDELITY_RATIO) * input.baselinePassRate;
}

function renderSpecForTests(spec: ModuleSpec): string {
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

function resolveRunner(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // dev: src/stages → src/harness/run-tests.ts ; built: dist/stages → dist/harness/run-tests.js
  const ts = join(here, '..', 'harness', 'run-tests.ts');
  if (existsSync(ts)) return ts;
  return join(here, '..', 'harness', 'run-tests.js');
}

function packageRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..');
}

function tsxCliPath(): string {
  const require = createRequire(import.meta.url);
  return join(dirname(require.resolve('tsx/package.json')), 'dist', 'cli.mjs');
}
