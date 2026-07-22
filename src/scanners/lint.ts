import { runProcess } from '../engine/proc.js';
import { LINT_CEILING_PER_KLOC, LINT_WARNING_WEIGHT, densityToScore } from './normalize.js';

/**
 * Lint cleanliness via ESLint. NOTE: the least reliable scanner — ESLint 9 flat
 * config needs a discoverable config and the right parser/plugins for the target's
 * language, which regenerated modules in a scratch dir usually lack. It is treated
 * as strictly best-effort: any failure returns null (dimension skipped, reported),
 * never a crash. See HANDOFF.md if you want to ship a bundled TS flat-config.
 */

export interface LintResult {
  score: number;
  errorCount: number;
  warningCount: number;
}

interface EslintFileReport {
  errorCount?: number;
  warningCount?: number;
}

/** Pure: aggregate ESLint JSON (array of per-file reports) into a density score. */
export function parseEslint(report: unknown, loc: number): LintResult {
  const files = Array.isArray(report) ? (report as EslintFileReport[]) : [];
  const errorCount = files.reduce((s, f) => s + (f.errorCount ?? 0), 0);
  const warningCount = files.reduce((s, f) => s + (f.warningCount ?? 0), 0);
  const weighted = errorCount + LINT_WARNING_WEIGHT * warningCount;
  return { score: densityToScore(weighted, loc, LINT_CEILING_PER_KLOC), errorCount, warningCount };
}

export async function runLint(targetDir: string, loc: number): Promise<LintResult | null> {
  try {
    const { stdout, timedOut } = await runProcess(
      'npx',
      ['--no-install', 'eslint', '--format', 'json', targetDir],
      { timeoutMs: 120_000 },
    );
    if (timedOut || !stdout.trim().startsWith('[')) return null;
    return parseEslint(JSON.parse(stdout), loc);
  } catch {
    return null;
  }
}
