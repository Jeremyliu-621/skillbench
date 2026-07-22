import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { Dimension, RunResult } from './types.js';

/**
 * Run history — the longitudinal view.
 *
 * The uplift number is only half the story: the vanilla-LLM baseline is a MOVING
 * TARGET. As frontier models improve, the same codebase's uplift should shrink
 * unless the custom pipeline improves too. Tracking that over time is exactly
 * a common agency methodology (observe vanilla behavior → optimize → re-
 * benchmark against evolving LLM capability), so every run appends one line to
 * `history.jsonl` and the report charts the series.
 *
 * Append-only JSONL: cheap, diff-friendly, and a corrupt line can never take out
 * the whole history (bad lines are skipped, not thrown).
 */

export interface HistoryEntry {
  at: string;
  repoRoot: string;
  /** What was measured — lets a dashboard separate codebases from skills. */
  subjectKind: 'codebase' | 'skill';
  subjectName: string;
  uplift: number;
  upliftLo: number;
  upliftHi: number;
  winRate: number;
  gatePass: boolean;
  gateThreshold: number;
  modulesSampled: number;
  specSource: string;
  /** Which vanilla model the baseline came from — the moving target. */
  baselineModel: string;
  dimensionUplift: Partial<Record<Dimension, number>>;
  warnings: number;
}

export const HISTORY_FILE = 'history.jsonl';

export function toHistoryEntry(result: RunResult): HistoryEntry {
  const dimensionUplift: Partial<Record<Dimension, number>> = {};
  for (const d of result.dimensions) {
    if (d.inUplift) dimensionUplift[d.dimension] = d.uplift;
  }
  return {
    at: result.meta.finishedAt,
    repoRoot: result.meta.repoRoot,
    subjectKind: result.meta.subject?.kind ?? 'codebase',
    subjectName: result.meta.subject?.name ?? shortName(result.meta.repoRoot),
    uplift: result.headline.uplift.estimate,
    upliftLo: result.headline.uplift.lo,
    upliftHi: result.headline.uplift.hi,
    winRate: result.headline.winRate.estimate,
    gatePass: result.headline.gate.pass,
    gateThreshold: result.headline.gate.threshold,
    modulesSampled: result.meta.modulesSampled,
    specSource: result.meta.specSource,
    baselineModel: result.meta.baselineModel,
    dimensionUplift,
    warnings: result.meta.warnings.length,
  };
}

export async function appendHistory(outDir: string, result: RunResult): Promise<void> {
  const path = join(outDir, HISTORY_FILE);
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${JSON.stringify(toHistoryEntry(result))}\n`, 'utf8');
}

/** Read history oldest-first. Unparseable lines are skipped, never fatal. */
export async function readHistory(outDir: string): Promise<HistoryEntry[]> {
  const raw = await readFile(join(outDir, HISTORY_FILE), 'utf8').catch(() => '');
  return parseHistory(raw);
}

/**
 * History is append-only and outlives tool versions, so lines written by an
 * older build can be missing fields added later. Normalize on read rather than
 * letting a stale line crash a reader — an old run is still a real data point.
 */
export function parseHistory(raw: string): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line) as Partial<HistoryEntry>;
      if (typeof parsed.uplift !== 'number' || typeof parsed.at !== 'string') continue;
      const repoRoot = parsed.repoRoot ?? '(unknown)';
      entries.push({
        ...(parsed as HistoryEntry),
        repoRoot,
        subjectKind: parsed.subjectKind ?? 'codebase',
        subjectName: parsed.subjectName ?? shortName(repoRoot),
        warnings: parsed.warnings ?? 0,
        dimensionUplift: parsed.dimensionUplift ?? {},
      });
    } catch {
      // skip corrupt line
    }
  }
  return entries;
}

export interface TrendSummary {
  runs: number;
  first: HistoryEntry;
  latest: HistoryEntry;
  /** Change in uplift from the previous run (null when there is no previous). */
  deltaFromPrevious: number | null;
  /** Change in uplift across the whole history. */
  deltaFromFirst: number;
  /** True when the baseline model changed since the previous run — an uplift
   *  move across a model change is a capability shift, not a pipeline regression. */
  baselineChanged: boolean;
  direction: 'up' | 'down' | 'flat';
}

/**
 * Find every result directory under the given paths. A path that directly holds
 * `history.jsonl` counts; otherwise we look one level down, so `2bench dashboard
 * ./results` works when each client has its own subdirectory.
 */
export async function discoverHistories(paths: readonly string[]): Promise<TrackedSource[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const found: TrackedSource[] = [];
  const seen = new Set<string>();

  const consider = async (dir: string): Promise<boolean> => {
    const entries = await readHistory(dir);
    if (entries.length === 0 || seen.has(dir)) return false;
    seen.add(dir);
    found.push({ source: dir, entries });
    return true;
  };

  for (const p of paths) {
    const info = await stat(p).catch(() => null);
    if (!info?.isDirectory()) continue;
    if (await consider(p)) continue;
    for (const child of await readdir(p, { withFileTypes: true }).catch(() => [])) {
      if (child.isDirectory()) await consider(join(p, child.name));
    }
  }
  return found;
}

export interface TrackedSource {
  source: string;
  entries: HistoryEntry[];
}

/** Last one or two path segments — enough to identify a repo without the full path. */
export function shortName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || p;
}

export const FLAT_BAND = 0.01;

export function summarizeTrend(entries: readonly HistoryEntry[]): TrendSummary | null {
  if (entries.length === 0) return null;
  const latest = entries[entries.length - 1]!;
  const previous = entries.length > 1 ? entries[entries.length - 2]! : null;
  const deltaFromPrevious = previous ? latest.uplift - previous.uplift : null;
  return {
    runs: entries.length,
    first: entries[0]!,
    latest,
    deltaFromPrevious,
    deltaFromFirst: latest.uplift - entries[0]!.uplift,
    baselineChanged: previous ? previous.baselineModel !== latest.baselineModel : false,
    direction:
      deltaFromPrevious === null || Math.abs(deltaFromPrevious) < FLAT_BAND
        ? 'flat'
        : deltaFromPrevious > 0
          ? 'up'
          : 'down',
  };
}
