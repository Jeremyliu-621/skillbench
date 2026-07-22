import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { RunResult } from '../types.js';

/** CI-facing output: score.json + exit code. */
export async function writeJsonReport(result: RunResult, outPath: string): Promise<void> {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(result, null, 2), 'utf8');
}

/** Exit code contract: 0 = gate passed, 1 = gate failed, 2 = run error (thrown). */
export function exitCodeFor(result: RunResult): number {
  return result.headline.gate.pass ? 0 : 1;
}
