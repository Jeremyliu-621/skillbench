import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { BenchConfig } from './types.js';

const DEFAULT_CONFIG_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '2bench.config.json',
);

export async function loadConfig(path?: string): Promise<BenchConfig> {
  const raw = JSON.parse(await readFile(path ?? DEFAULT_CONFIG_PATH, 'utf8'));
  const config: BenchConfig = {
    gate: { upliftThreshold: raw.gate.upliftThreshold },
    weights: raw.weights,
    sampling: raw.sampling,
    baseline: raw.baseline,
    judge: raw.judge,
    stats: raw.stats,
  };
  validateConfig(config);
  return config;
}

export function validateConfig(config: BenchConfig): void {
  const weightSum = Object.values(config.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(weightSum - 1) > 1e-9) {
    throw new Error(`Dimension weights must sum to 1, got ${weightSum}`);
  }
  if (config.gate.upliftThreshold < 0) {
    throw new Error('gate.upliftThreshold must be >= 0');
  }
  if (config.sampling.minModules < 1 || config.sampling.maxModules < config.sampling.minModules) {
    throw new Error('sampling.minModules/maxModules invalid');
  }
}
