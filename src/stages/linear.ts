/**
 * Linear → spec loader (roadmap item X2).
 *
 * WHY THIS SHAPE (the "most scalable way"): real tickets are the gold-standard
 * spec source — they defeat spec-circularity, because a ticket written before
 * the code can't have been traced from it. Rather than wire a Linear client into
 * the scoring pipeline, this is a *decoupled loader*: it pulls issues and writes
 * the same `<specsDir>/<module-key>.json` files that `score --specs` already
 * consumes (X1). That decoupling is what makes it scale:
 *   - fetch and score are independent → resumable, cacheable, offline-scoreable;
 *   - the transport is INJECTED → testable with no network, and the same seam
 *     works for Jira / GitHub Issues / a CSV export (anything that can emit the
 *     spec JSONs);
 *   - big workspaces are handled by cursor PAGINATION + incremental `since`
 *     sync (a checkpoint of the newest updatedAt) + 429 backoff;
 *   - mapping is DECLARATIVE (a `spec:<path>` label per issue, or a map file) so
 *     there's no central registry to maintain as modules/tickets grow.
 *
 * Auth comes from LINEAR_API_KEY (never argv) — a Linear personal API key.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join, normalize, sep } from 'node:path';

export interface LinearIssue {
  id: string;
  identifier: string;
  title: string;
  description: string;
  labels: string[];
  updatedAt: string;
}

/** Injected transport so this is unit-tested without hitting the network. */
export interface LinearTransport {
  query<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T>;
}

export class LinearError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'LinearError';
  }
}

const ENDPOINT = 'https://api.linear.app/graphql';

/** Real transport over global fetch (Node ≥18). Retries 429/5xx with backoff. */
export function createLinearTransport(apiKey: string, opts: { retries?: number; sleep?: (ms: number) => Promise<void> } = {}): LinearTransport {
  const retries = opts.retries ?? 3;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  return {
    async query<T>(query: string, variables: Record<string, unknown>): Promise<T> {
      for (let attempt = 0; ; attempt++) {
        const res = await fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: apiKey },
          body: JSON.stringify({ query, variables }),
        });
        if ((res.status === 429 || res.status >= 500) && attempt < retries) {
          const retryAfter = Number(res.headers.get('retry-after'));
          await sleep(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 2 ** attempt * 1000);
          continue;
        }
        if (!res.ok) throw new LinearError(`Linear API HTTP ${res.status}`, res.status);
        const json = (await res.json()) as { data?: T; errors?: { message: string }[] };
        if (json.errors?.length) throw new LinearError(`Linear GraphQL: ${json.errors.map((e) => e.message).join('; ')}`);
        return json.data as T;
      }
    },
  };
}

// ── fetching ────────────────────────────────────────────────────────────────

export interface IssueFilterOptions {
  team?: string;
  project?: string;
  label?: string;
  /** ISO timestamp — only issues updated at/after this (incremental sync). */
  since?: string;
}

/** Build a Linear IssueFilter from the CLI options. */
export function buildIssueFilter(opts: IssueFilterOptions): Record<string, unknown> {
  const filter: Record<string, unknown> = {};
  if (opts.team) filter.team = { key: { eq: opts.team } };
  if (opts.project) filter.project = { name: { eq: opts.project } };
  if (opts.label) filter.labels = { some: { name: { eq: opts.label } } };
  if (opts.since) filter.updatedAt = { gte: opts.since };
  return filter;
}

const ISSUES_QUERY = `query Issues($first:Int!,$after:String,$filter:IssueFilter){
  issues(first:$first, after:$after, filter:$filter){
    pageInfo{ hasNextPage endCursor }
    nodes{ id identifier title description updatedAt labels{ nodes{ name } } }
  }
}`;

interface IssuesPage {
  issues: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      id: string;
      identifier: string;
      title: string;
      description: string | null;
      updatedAt: string;
      labels: { nodes: { name: string }[] };
    }[];
  };
}

/** Fetch every matching issue, following cursor pagination. */
export async function fetchIssues(
  transport: LinearTransport,
  filter: Record<string, unknown>,
  opts: { pageSize?: number; onProgress?: (m: string) => void } = {},
): Promise<LinearIssue[]> {
  const pageSize = opts.pageSize ?? 50;
  const all: LinearIssue[] = [];
  let after: string | null = null;
  let page = 0;
  do {
    const data: IssuesPage = await transport.query<IssuesPage>(ISSUES_QUERY, { first: pageSize, after, filter });
    for (const n of data.issues.nodes) {
      all.push({
        id: n.id,
        identifier: n.identifier,
        title: n.title,
        description: n.description ?? '',
        labels: n.labels.nodes.map((l) => l.name),
        updatedAt: n.updatedAt,
      });
    }
    opts.onProgress?.(`fetched ${all.length} issue(s) (page ${++page})`);
    after = data.issues.pageInfo.hasNextPage ? data.issues.pageInfo.endCursor : null;
  } while (after);
  return all;
}

// ── mapping (issue → module) ─────────────────────────────────────────────────

export interface MapOptions {
  /** Label convention prefix; a label `spec:src/services/tax` maps that issue. */
  labelPrefix?: string;
  /** Optional map of label OR project name → module path/key (for team-by-project setups). */
  map?: Record<string, string>;
}

/** Turn a repo-relative path (or already-joined key) into a safe `__`-joined key, or null. */
export function safeModuleKey(raw: string): string | null {
  const key = raw.trim().replace(/^[/\\]+/, '').replace(/[/\\]+/g, '__');
  if (!key || key.includes('..') || /[<>:"|?*\x00]/.test(key)) return null;
  return key;
}

/** Which module (if any) this issue specifies. */
export function moduleKeyForIssue(issue: LinearIssue, opts: MapOptions = {}): string | null {
  const prefix = opts.labelPrefix ?? 'spec:';
  for (const label of issue.labels) {
    if (label.startsWith(prefix)) return safeModuleKey(label.slice(prefix.length));
  }
  if (opts.map) {
    for (const label of issue.labels) {
      if (opts.map[label]) return safeModuleKey(opts.map[label]!);
    }
  }
  return null;
}

// ── conversion (issue text → spec) ───────────────────────────────────────────

export interface RawSpec {
  title: string;
  requirements: string[];
  interfaces: string[];
  constraints: string[];
}

function classifyHeading(text: string): keyof Omit<RawSpec, 'title'> {
  const t = text.toLowerCase();
  if (/constraint|rule|validation|edge case|invariant|must not/.test(t)) return 'constraints';
  if (/interface|api|contract|endpoint|signature|method|function/.test(t)) return 'interfaces';
  return 'requirements';
}

/**
 * Deterministic conversion of a ticket into a business-level spec: markdown
 * headings route bullets into requirements / constraints / interfaces; prose
 * with no bullets becomes a single requirement so the spec is never empty.
 */
export function issueToSpec(issue: LinearIssue): RawSpec {
  const buckets: Omit<RawSpec, 'title'> = { requirements: [], interfaces: [], constraints: [] };
  let current: keyof Omit<RawSpec, 'title'> = 'requirements';

  for (const line of issue.description.split(/\r?\n/)) {
    const heading = line.match(/^#{1,6}\s+(.*\S)\s*$/) ?? line.match(/^\*\*(.+?)\*\*:?\s*$/);
    if (heading) {
      current = classifyHeading(heading[1]!);
      continue;
    }
    const bullet = line.match(/^\s*(?:[-*+]|\d+[.)])\s+(.*\S)\s*$/);
    if (bullet) buckets[current].push(bullet[1]!.trim());
  }

  if (buckets.requirements.length === 0 && buckets.constraints.length === 0 && buckets.interfaces.length === 0) {
    const prose = issue.description.replace(/\s+/g, ' ').trim();
    buckets.requirements.push(prose || `Implement the behavior described by ticket ${issue.identifier}: ${issue.title}`);
  }
  return { title: issue.title, ...buckets };
}

/** Merge several tickets that target the same module into one spec. */
export function mergeSpecs(key: string, issues: LinearIssue[]): RawSpec {
  const specs = issues.map(issueToSpec);
  const uniq = (xs: string[]) => [...new Set(xs.map((s) => s.trim()).filter(Boolean))];
  return {
    title: specs.length === 1 ? specs[0]!.title : `${key.replace(/__/g, '/')} — ${issues.length} Linear tickets`,
    requirements: uniq(specs.flatMap((s) => s.requirements)),
    interfaces: uniq(specs.flatMap((s) => s.interfaces)),
    constraints: uniq(specs.flatMap((s) => s.constraints)),
  };
}

// ── orchestration ─────────────────────────────────────────────────────────────

export interface PullOptions extends IssueFilterOptions, MapOptions {
  specsDir: string;
  pageSize?: number;
  onProgress?: (m: string) => void;
}

export interface PullResult {
  issues: number;
  modulesWritten: number;
  skippedUnmapped: number;
  /** Newest updatedAt seen — a checkpoint for the next incremental `--since` run. */
  lastSyncedAt: string | null;
  files: string[];
}

/** Pull matching issues and write one spec JSON per mapped module into specsDir. */
export async function pullLinearSpecs(transport: LinearTransport, opts: PullOptions): Promise<PullResult> {
  const filter = buildIssueFilter(opts);
  const issues = await fetchIssues(transport, filter, { pageSize: opts.pageSize, onProgress: opts.onProgress });

  const byModule = new Map<string, LinearIssue[]>();
  let skippedUnmapped = 0;
  for (const issue of issues) {
    const key = moduleKeyForIssue(issue, opts);
    if (!key) {
      skippedUnmapped++;
      continue;
    }
    (byModule.get(key) ?? byModule.set(key, []).get(key)!).push(issue);
  }

  await mkdir(opts.specsDir, { recursive: true });
  const files: string[] = [];
  const root = normalize(opts.specsDir + sep);
  for (const [key, group] of byModule) {
    const target = normalize(join(opts.specsDir, `${key}.json`));
    if (!target.startsWith(root)) continue; // defense-in-depth path guard
    await writeFile(target, JSON.stringify(mergeSpecs(key, group), null, 2), 'utf8');
    files.push(target);
    opts.onProgress?.(`wrote ${key}.json (${group.length} ticket(s))`);
  }

  const lastSyncedAt = issues.reduce<string | null>((max, i) => (max && max >= i.updatedAt ? max : i.updatedAt), null);
  if (lastSyncedAt) {
    await writeFile(
      join(opts.specsDir, '.linear-sync.json'),
      JSON.stringify({ lastSyncedAt, issues: issues.length, modules: byModule.size }, null, 2),
      'utf8',
    );
  }

  return { issues: issues.length, modulesWritten: byModule.size, skippedUnmapped, lastSyncedAt, files };
}
