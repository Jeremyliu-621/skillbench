import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import type { ModuleInfo, RepoInventory } from '../types.js';
import { mulberry32, shuffle } from '../stats/random.js';

/**
 * Stage 1: inventory — walk the repo, group source files into modules
 * (directory = module), classify, count LOC. Fully deterministic and free.
 */

const SKIP_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', 'out', 'coverage',
  '.next', '.turbo', '.2bench', 'vendor', '__pycache__',
]);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);

export async function inventory(repoRoot: string): Promise<RepoInventory> {
  const rootStat = await stat(repoRoot).catch(() => null);
  if (!rootStat?.isDirectory()) {
    throw new Error(`Not a directory: ${repoRoot}`);
  }

  const filesByDir = new Map<string, string[]>();
  await walk(repoRoot, repoRoot, filesByDir);

  const modules: ModuleInfo[] = [];
  let totalLoc = 0;
  for (const [dir, files] of filesByDir) {
    const loc = await countLoc(files.map((f) => join(repoRoot, f)));
    totalLoc += loc;
    const posixDir = dir.split(sep).join('/') || '.';
    modules.push({
      id: posixDir,
      name: posixDir.split('/').pop() ?? posixDir,
      rootDir: join(repoRoot, dir),
      files: files.map((f) => f.split(sep).join('/')),
      loc,
      subsystem: posixDir === '.' ? '(root)' : posixDir.split('/')[0]!,
      kind: classify(posixDir),
    });
  }

  modules.sort((a, b) => a.id.localeCompare(b.id));
  return { repoRoot, modules, totalLoc };
}

async function walk(repoRoot: string, dir: string, acc: Map<string, string[]>): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
      await walk(repoRoot, join(dir, entry.name), acc);
    } else if (entry.isFile() && isSourceFile(entry.name)) {
      const rel = relative(repoRoot, join(dir, entry.name));
      const relDir = relative(repoRoot, dir);
      const list = acc.get(relDir) ?? [];
      list.push(rel);
      acc.set(relDir, list);
    }
  }
}

export function isSourceFile(name: string): boolean {
  const lower = name.toLowerCase();
  if (lower.endsWith('.d.ts')) return false;
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(lower)) return false;
  const ext = lower.slice(lower.lastIndexOf('.'));
  return SOURCE_EXTENSIONS.has(ext);
}

function classify(dirPosix: string): ModuleInfo['kind'] {
  const p = dirPosix.toLowerCase();
  if (/(^|\/)(routes?|api|controllers?|endpoints?)(\/|$)/.test(p)) return 'route';
  if (/(^|\/)(services?|domain|core|logic)(\/|$)/.test(p)) return 'service';
  if (/(^|\/)(components?|pages?|views?|ui)(\/|$)/.test(p)) return 'ui';
  return 'lib';
}

async function countLoc(absFiles: string[]): Promise<number> {
  let loc = 0;
  for (const file of absFiles) {
    const content = await readFile(file, 'utf8').catch(() => '');
    for (const line of content.split('\n')) {
      if (line.trim().length > 0) loc++;
    }
  }
  return loc;
}

/**
 * Stratified, seeded module sampling: proportional allocation per subsystem
 * (each non-trivial subsystem gets at least one pick), deterministic under a
 * fixed seed. Tiny modules (< minLoc) are excluded — regenerating a 5-line
 * barrel file tells us nothing.
 */
export function sampleModules(
  modules: readonly ModuleInfo[],
  opts: { size: number; seed: number; minLoc?: number },
): ModuleInfo[] {
  const minLoc = opts.minLoc ?? 30;
  const eligible = modules.filter((m) => m.loc >= minLoc);
  if (eligible.length <= opts.size) return [...eligible];

  const rng = mulberry32(opts.seed);
  const bySubsystem = new Map<string, ModuleInfo[]>();
  for (const m of eligible) {
    const list = bySubsystem.get(m.subsystem) ?? [];
    list.push(m);
    bySubsystem.set(m.subsystem, list);
  }

  // Proportional allocation with a floor of 1 per subsystem (stratification),
  // then fill remaining slots from the largest remainders.
  const subsystems = [...bySubsystem.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  const picked: ModuleInfo[] = [];
  const shuffled = new Map(subsystems.map(([name, mods]) => [name, shuffle(mods, rng)]));

  const quotas = new Map<string, number>();
  for (const [name, mods] of subsystems) {
    quotas.set(name, Math.max(1, Math.floor((mods.length / eligible.length) * opts.size)));
  }
  for (const [name, quota] of quotas) {
    picked.push(...shuffled.get(name)!.slice(0, quota));
  }
  // Trim overshoot / fill undershoot deterministically.
  const remaining = shuffle(
    [...shuffled.values()].flatMap((mods, i) => mods.slice(quotas.get(subsystems[i]![0])!)),
    rng,
  );
  while (picked.length < opts.size && remaining.length > 0) {
    picked.push(remaining.shift()!);
  }
  return picked.slice(0, opts.size).sort((a, b) => a.id.localeCompare(b.id));
}
