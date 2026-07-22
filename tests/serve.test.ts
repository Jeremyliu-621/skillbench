import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { serveDashboard, type ServeHandle } from '../src/serve.js';

describe('serveDashboard', () => {
  let root: string;
  let handle: ServeHandle | null = null;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), '2bench-serve-'));
    const sub = join(root, 'projectA');
    await mkdir(sub, { recursive: true });
    await writeFile(
      join(sub, 'history.jsonl'),
      `${JSON.stringify({
        at: '2026-07-20T00:00:00.000Z',
        repoRoot: '/clients/acme/erp',
        subjectKind: 'codebase',
        subjectName: 'acme/erp',
        uplift: 0.5, upliftLo: 0.42, upliftHi: 0.6, winRate: 0.8,
        gatePass: true, gateThreshold: 0.4, modulesSampled: 5,
        specSource: 'linear', baselineModel: 'codex-default',
        dimensionUplift: {}, warnings: 0,
      })}\n`,
      'utf8',
    );
    await writeFile(join(sub, 'report.html'), '<!doctype html><title>full report</title>REPORT BODY', 'utf8');
  });

  afterEach(async () => {
    await handle?.close();
    handle = null;
    await rm(root, { recursive: true, force: true });
  });

  it('serves the dashboard on loopback and lists the subject', async () => {
    handle = await serveDashboard({ dirs: [root], port: 0 });
    expect(handle.url).toContain('127.0.0.1');
    const res = await fetch(handle.url);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('acme/erp');
    expect(html).toContain('2bench');
  });

  it('links each subject to its full report and serves it', async () => {
    handle = await serveDashboard({ dirs: [root], port: 0 });
    const html = await (await fetch(handle.url)).text();
    expect(html).toContain('href="/r/0"');
    const report = await fetch(`${handle.url}r/0`);
    expect(report.status).toBe(200);
    expect(await report.text()).toContain('REPORT BODY');
  });

  it('explains a missing report instead of erroring blankly', async () => {
    await rm(join(root, 'projectA', 'report.html'));
    handle = await serveDashboard({ dirs: [root], port: 0 });
    const res = await fetch(`${handle.url}r/0`);
    expect(res.status).toBe(404);
    expect(await res.text()).toContain('No report.html');
  });

  it('404s unknown paths and out-of-range subjects', async () => {
    handle = await serveDashboard({ dirs: [root], port: 0 });
    expect((await fetch(`${handle.url}nope`)).status).toBe(404);
    expect((await fetch(`${handle.url}r/99`)).status).toBe(404);
  });

  it('picks up a run that lands while the server is already open', async () => {
    handle = await serveDashboard({ dirs: [root], port: 0 });
    expect(await (await fetch(handle.url)).text()).not.toContain('later/project');

    const late = join(root, 'projectB');
    await mkdir(late, { recursive: true });
    await writeFile(
      join(late, 'history.jsonl'),
      `${JSON.stringify({
        at: '2026-07-21T00:00:00.000Z', repoRoot: '/later/project',
        subjectKind: 'codebase', subjectName: 'later/project',
        uplift: 0.2, upliftLo: 0.1, upliftHi: 0.3, winRate: 0.6,
        gatePass: false, gateThreshold: 0.4, modulesSampled: 2,
        specSource: 'linear', baselineModel: 'codex-default',
        dimensionUplift: {}, warnings: 0,
      })}\n`,
      'utf8',
    );
    // No restart: results are re-read per request.
    expect(await (await fetch(handle.url)).text()).toContain('later/project');
  });
});
