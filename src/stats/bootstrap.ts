import type { ConfidenceInterval } from '../types.js';
import { mulberry32 } from './random.js';

export interface BootstrapOptions {
  iterations?: number;
  confidence?: number;
  seed?: number;
  /** Statistic to compute over a resample. Defaults to the mean. */
  statistic?: (values: number[]) => number;
}

/**
 * Percentile-bootstrap confidence interval over per-module values
 * (e.g., per-module paired uplift). Seeded, so identical inputs always
 * produce identical intervals.
 *
 * Known limitation (documented in research-report §2.5): plain bootstrap also
 * under-covers at very small N. Acceptable for the demo; the hardening path is
 * paired-Bayesian / hierarchical intervals (see HANDOFF.md task S1).
 */
export function bootstrapCI(values: readonly number[], opts: BootstrapOptions = {}): ConfidenceInterval {
  if (values.length === 0) {
    throw new Error('bootstrapCI requires at least one value');
  }
  const iterations = opts.iterations ?? 2000;
  const confidence = opts.confidence ?? 0.95;
  const stat = opts.statistic ?? mean;
  const rng = mulberry32(opts.seed ?? 42);

  const estimates: number[] = new Array(iterations);
  const resample: number[] = new Array(values.length);
  for (let i = 0; i < iterations; i++) {
    for (let j = 0; j < values.length; j++) {
      resample[j] = values[Math.floor(rng() * values.length)]!;
    }
    estimates[i] = stat(resample);
  }
  estimates.sort((a, b) => a - b);

  const alpha = 1 - confidence;
  const lo = quantileSorted(estimates, alpha / 2);
  const hi = quantileSorted(estimates, 1 - alpha / 2);
  return { estimate: stat([...values]), lo, hi, method: 'bootstrap-percentile' };
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return NaN;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/**
 * Cluster bootstrap: resample CLUSTERS (e.g. subsystems) with replacement and
 * take every member of each drawn cluster. Modules from one subsystem are
 * correlated (shared authors, shared conventions), so treating them as
 * independent draws understates uncertainty — clustered standard errors can be
 * >3× naive ones (research-report §2.5). Falls back to the plain bootstrap when
 * there's no real clustering (≤1 cluster, or every cluster is a singleton).
 */
export function clusterBootstrapCI(
  values: readonly { value: number; cluster: string }[],
  opts: BootstrapOptions = {},
): ConfidenceInterval {
  if (values.length === 0) {
    throw new Error('clusterBootstrapCI requires at least one value');
  }
  const byCluster = new Map<string, number[]>();
  for (const v of values) {
    const list = byCluster.get(v.cluster) ?? [];
    list.push(v.value);
    byCluster.set(v.cluster, list);
  }
  const clusters = [...byCluster.values()];
  const allSingletons = clusters.every((c) => c.length === 1);
  if (clusters.length <= 1 || allSingletons) {
    return bootstrapCI(values.map((v) => v.value), opts);
  }

  const iterations = opts.iterations ?? 2000;
  const confidence = opts.confidence ?? 0.95;
  const stat = opts.statistic ?? mean;
  const rng = mulberry32(opts.seed ?? 42);

  const estimates: number[] = new Array(iterations);
  for (let i = 0; i < iterations; i++) {
    const resample: number[] = [];
    for (let c = 0; c < clusters.length; c++) {
      resample.push(...clusters[Math.floor(rng() * clusters.length)]!);
    }
    estimates[i] = stat(resample);
  }
  estimates.sort((a, b) => a - b);
  const alpha = 1 - confidence;
  return {
    estimate: stat(values.map((v) => v.value)),
    lo: quantileSorted(estimates, alpha / 2),
    hi: quantileSorted(estimates, 1 - alpha / 2),
    method: 'cluster-bootstrap',
  };
}

function quantileSorted(sorted: readonly number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  const lower = sorted[base]!;
  const upper = sorted[Math.min(base + 1, sorted.length - 1)]!;
  return lower + rest * (upper - lower);
}
