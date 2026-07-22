import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  buildIssueFilter,
  fetchIssues,
  issueToSpec,
  moduleKeyForIssue,
  pullLinearSpecs,
  safeModuleKey,
  type LinearIssue,
  type LinearTransport,
} from '../src/stages/linear.js';
import { loadExternalSpec } from '../src/stages/spec-extract.js';
import type { ModuleInfo } from '../src/types.js';

// A GraphQL node as the API returns it.
function node(over: Partial<{ id: string; identifier: string; title: string; description: string | null; updatedAt: string; labels: string[] }> = {}) {
  return {
    id: over.id ?? 'i1',
    identifier: over.identifier ?? 'ERP-1',
    title: over.title ?? 'A ticket',
    description: over.description ?? '',
    updatedAt: over.updatedAt ?? '2026-07-01T00:00:00.000Z',
    labels: { nodes: (over.labels ?? []).map((name) => ({ name })) },
  };
}

/** Fake transport that serves pre-baked pages and records the variables it saw. */
function fakeTransport(pages: unknown[]): { transport: LinearTransport; calls: Record<string, unknown>[] } {
  const calls: Record<string, unknown>[] = [];
  let i = 0;
  return {
    calls,
    transport: {
      async query<T>(_q: string, vars: Record<string, unknown>): Promise<T> {
        calls.push(vars);
        return (pages[Math.min(i++, pages.length - 1)] as T);
      },
    },
  };
}

const issue = (over: Partial<LinearIssue> = {}): LinearIssue => ({
  id: 'i', identifier: 'ERP-1', title: 't', description: '', labels: [], updatedAt: '2026-07-01T00:00:00.000Z', ...over,
});

describe('safeModuleKey', () => {
  it('joins path separators and strips a leading slash', () => {
    expect(safeModuleKey('src/services/tax')).toBe('src__services__tax');
    expect(safeModuleKey('/src/tax')).toBe('src__tax');
  });
  it('rejects traversal, empties, and illegal characters', () => {
    expect(safeModuleKey('../etc/passwd')).toBeNull();
    expect(safeModuleKey('a/../b')).toBeNull();
    expect(safeModuleKey('   ')).toBeNull();
    expect(safeModuleKey('a:b')).toBeNull();
  });
});

describe('moduleKeyForIssue', () => {
  it('maps via the label convention', () => {
    expect(moduleKeyForIssue(issue({ labels: ['bug', 'spec:src/services/tax'] }))).toBe('src__services__tax');
  });
  it('falls back to a map file entry (label or project name)', () => {
    expect(moduleKeyForIssue(issue({ labels: ['Tax'] }), { map: { Tax: 'src/services/tax' } })).toBe('src__services__tax');
  });
  it('returns null when nothing maps, and never escapes via a crafted label', () => {
    expect(moduleKeyForIssue(issue({ labels: ['random'] }))).toBeNull();
    expect(moduleKeyForIssue(issue({ labels: ['spec:../../etc'] }))).toBeNull();
  });
});

describe('issueToSpec', () => {
  it('routes markdown sections into requirements / constraints / interfaces', () => {
    const spec = issueToSpec(
      issue({
        title: 'Tax calc',
        description: [
          '## Requirements',
          '- return all rates for a province',
          '## Constraints',
          '- each line rounds independently',
          '## API',
          '- calcTax(amount, province): number',
        ].join('\n'),
      }),
    );
    expect(spec.title).toBe('Tax calc');
    expect(spec.requirements).toContain('return all rates for a province');
    expect(spec.constraints).toContain('each line rounds independently');
    expect(spec.interfaces).toContain('calcTax(amount, province): number');
  });

  it('falls back to prose as a single requirement when there are no bullets', () => {
    const spec = issueToSpec(issue({ description: 'Just a sentence describing the behavior.' }));
    expect(spec.requirements).toEqual(['Just a sentence describing the behavior.']);
  });

  it('never produces an empty spec even with no description', () => {
    const spec = issueToSpec(issue({ identifier: 'ERP-9', title: 'Do the thing', description: '' }));
    expect(spec.requirements.length).toBeGreaterThan(0);
  });
});

describe('buildIssueFilter', () => {
  it('translates options into a Linear IssueFilter', () => {
    expect(buildIssueFilter({ team: 'ERP', label: 'spec', since: '2026-07-01T00:00:00Z' })).toEqual({
      team: { key: { eq: 'ERP' } },
      labels: { some: { name: { eq: 'spec' } } },
      updatedAt: { gte: '2026-07-01T00:00:00Z' },
    });
  });
});

describe('fetchIssues', () => {
  it('follows cursor pagination across pages', async () => {
    const { transport, calls } = fakeTransport([
      { issues: { pageInfo: { hasNextPage: true, endCursor: 'c1' }, nodes: [node({ id: 'a' })] } },
      { issues: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [node({ id: 'b' })] } },
    ]);
    const issues = await fetchIssues(transport, {}, { pageSize: 1 });
    expect(issues.map((i) => i.id)).toEqual(['a', 'b']);
    expect(calls[0]!.after).toBeNull();
    expect(calls[1]!.after).toBe('c1'); // second page used the first page's cursor
  });
});

describe('pullLinearSpecs', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), '2bench-linear-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes one spec per mapped module, skips unmapped, and checkpoints', async () => {
    const { transport } = fakeTransport([
      {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [
            node({ id: '1', updatedAt: '2026-07-02T00:00:00.000Z', title: 'Tax rates', description: '- return all rates', labels: ['spec:src/services/tax'] }),
            node({ id: '2', updatedAt: '2026-07-05T00:00:00.000Z', title: 'Tax rounding', description: '## Constraints\n- round each line', labels: ['spec:src/services/tax'] }),
            node({ id: '3', updatedAt: '2026-07-03T00:00:00.000Z', title: 'Invoicing', description: '- create an invoice', labels: ['spec:src/services/invoicing'] }),
            node({ id: '4', title: 'Untagged chore', description: 'no mapping', labels: ['chore'] }),
          ],
        },
      },
    ]);

    const result = await pullLinearSpecs(transport, { specsDir: dir });
    expect(result.issues).toBe(4);
    expect(result.modulesWritten).toBe(2); // tax (2 tickets merged) + invoicing
    expect(result.skippedUnmapped).toBe(1);
    expect(result.lastSyncedAt).toBe('2026-07-05T00:00:00.000Z'); // newest updatedAt

    const tax = JSON.parse(await readFile(join(dir, 'src__services__tax.json'), 'utf8'));
    expect(tax.requirements).toContain('return all rates');
    expect(tax.constraints).toContain('round each line'); // merged from the second ticket

    const checkpoint = JSON.parse(await readFile(join(dir, '.linear-sync.json'), 'utf8'));
    expect(checkpoint.lastSyncedAt).toBe('2026-07-05T00:00:00.000Z');
  });

  it('produces files that load through the real external-spec path as source "linear"', async () => {
    const { transport } = fakeTransport([
      {
        issues: {
          pageInfo: { hasNextPage: false, endCursor: null },
          nodes: [node({ id: '1', title: 'Tax', description: '- compute tax', labels: ['spec:src/services/tax'] })],
        },
      },
    ]);
    await pullLinearSpecs(transport, { specsDir: dir });

    const module: ModuleInfo = {
      id: 'src/services/tax', name: 'tax', rootDir: '/x', files: [], loc: 10, subsystem: 'src', kind: 'service',
    };
    const spec = await loadExternalSpec(module, dir);
    expect(spec).not.toBeNull();
    expect(spec!.source).toBe('linear');
    expect(spec!.title).toBe('Tax');
    expect(spec!.requirements).toContain('compute tax');
  });
});
