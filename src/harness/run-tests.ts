import { pathToFileURL } from 'node:url';
import * as assert from 'node:assert/strict';
import { collectSourceFiles } from '../scanners/complexity.js';

/**
 * Child-process entry: run a generated test suite against one implementation.
 *
 *   npx tsx src/harness/run-tests.ts <implDir> <testFile>
 *
 * Contract (also stated in the test-generation prompt, stages/testgen.ts):
 *  - The implementation is presented to tests as `subject` — the merged named
 *    exports of every source file in <implDir>. No shims, no fixed entry file,
 *    so the SAME suite runs against the repo module and each baseline candidate
 *    regardless of file layout (the differential-oracle requirement).
 *  - The test file exports `tests: { name, run(subject, assert) }[]`;
 *    `assert` is node:assert/strict. Tests must not import anything.
 *
 * Output: a single line `2BENCH_RESULT {json}` on stdout — a marker prefix so
 * stray console.log calls in imported subject code can't corrupt the parse.
 * Subject code is EXECUTED here; the parent isolates this in a child process
 * with a timeout (same trust level as running the candidate's tests at all).
 */

interface RunReport {
  total: number;
  passed: number;
  importedFiles: number;
  failedImports: { file: string; error: string }[];
  failures: { name: string; error: string }[];
}

async function main(): Promise<void> {
  const [implDir, testFile] = process.argv.slice(2);
  if (!implDir || !testFile) {
    throw new Error('usage: run-tests <implDir> <testFile>');
  }

  const report: RunReport = { total: 0, passed: 0, importedFiles: 0, failedImports: [], failures: [] };

  const subject: Record<string, unknown> = {};
  const files = (await collectSourceFiles(implDir)).sort();
  for (const file of files) {
    try {
      const mod = (await import(pathToFileURL(file).href)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (name !== 'default') subject[name] = value;
      }
      report.importedFiles++;
    } catch (err) {
      report.failedImports.push({ file, error: message(err) });
    }
  }

  const testsMod = (await import(pathToFileURL(testFile).href)) as {
    tests?: { name: string; run: (subject: unknown, assert: unknown) => void | Promise<void> }[];
  };
  const tests = Array.isArray(testsMod.tests) ? testsMod.tests : [];
  report.total = tests.length;

  for (const test of tests) {
    try {
      await test.run(subject, assert);
      report.passed++;
    } catch (err) {
      report.failures.push({ name: test.name, error: message(err).slice(0, 300) });
    }
  }

  process.stdout.write(`2BENCH_RESULT ${JSON.stringify(report)}\n`);
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

main().catch((err) => {
  process.stdout.write(`2BENCH_RESULT ${JSON.stringify({ fatal: message(err) })}\n`);
  process.exitCode = 1;
});
