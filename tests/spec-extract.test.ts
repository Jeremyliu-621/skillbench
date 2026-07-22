import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadExternalSpec, specLeakage } from '../src/stages/spec-extract.js';
import type { ModuleInfo, ModuleSpec } from '../src/types.js';

const module_ = (id: string): ModuleInfo => ({
  id,
  name: id.split('/').pop()!,
  rootDir: `/repo/${id}`,
  files: [],
  loc: 100,
  subsystem: id.split('/')[0]!,
  kind: 'service',
});

describe('loadExternalSpec', () => {
  let specsDir: string;

  beforeAll(async () => {
    specsDir = await mkdtemp(join(tmpdir(), '2bench-specs-'));
    await writeFile(
      join(specsDir, 'src__services__tax.json'),
      JSON.stringify({
        title: 'Tax rules',
        requirements: ['a province can levy multiple rates; return every applicable rate'],
        interfaces: ['taxFor(amount, province)'],
        constraints: ['reject negative amounts'],
      }),
      'utf8',
    );
    await writeFile(join(specsDir, 'src__bad.json'), '{"nope": true}', 'utf8');
  });

  afterAll(async () => {
    await rm(specsDir, { recursive: true, force: true });
  });

  it('loads a spec by module key and marks it linear', async () => {
    const spec = await loadExternalSpec(module_('src/services/tax'), specsDir);
    expect(spec).not.toBeNull();
    expect(spec!.source).toBe('linear');
    expect(spec!.moduleId).toBe('src/services/tax');
    expect(spec!.requirements).toHaveLength(1);
  });

  it('returns null for a missing or malformed file', async () => {
    expect(await loadExternalSpec(module_('src/services/other'), specsDir)).toBeNull();
    expect(await loadExternalSpec(module_('src/bad'), specsDir)).toBeNull();
  });
});

describe('specLeakage', () => {
  const spec = (requirements: string[], interfaces: string[] = []): ModuleSpec => ({
    moduleId: 'm',
    title: 'Spec',
    requirements,
    interfaces,
    constraints: [],
    source: 'extracted',
  });

  const source = `
    export function taxFor(amount, province) { return applyZoneRates(amount, lookupRates(province)); }
    function applyZoneRates(a, r) {}
    function lookupRates(p) {}
  `;

  it('is high when requirements echo internal identifiers', () => {
    const leaky = spec(['calls applyZoneRates then lookupRates for the province']);
    expect(specLeakage(leaky, source)).toBeGreaterThan(0.5);
  });

  it('is low for business-level language', () => {
    const clean = spec(['each province may levy multiple sales taxRates that must all be returned']);
    expect(specLeakage(clean, source)).toBeLessThan(0.5);
  });

  it('does not count public interface names as leakage', () => {
    const withInterface = spec(['taxFor computes the taxAmount owed'], ['taxFor(amount, province)']);
    // 'taxFor' is in the declared interface → excluded; 'taxAmount' is not in source.
    expect(specLeakage(withInterface, source)).toBe(0);
  });

  it('returns 0 when the spec has no distinctive words', () => {
    expect(specLeakage(spec(['plain words only here']), source)).toBe(0);
  });
});
