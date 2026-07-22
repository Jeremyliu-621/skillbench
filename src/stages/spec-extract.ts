import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ModuleInfo, ModuleSpec } from '../types.js';
import { codexExecJson } from '../engine/codex.js';

/**
 * Stage 2: spec extraction.
 *
 * INFORMATION-PARITY RULE (research-report §5, "spec circularity"): the baseline
 * LLM must receive the same information the delivery pipeline received — business
 * requirements — NOT a distillation of the finished code's cleverness.
 * Preference order:
 *   1. Real Linear tickets / spec docs when available (source: 'linear').
 *   2. Extraction from code at business-logic altitude only (source: 'extracted'),
 *      flagged in the final report as a methodological caveat.
 */

export const SPEC_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['title', 'requirements', 'interfaces', 'constraints'],
  properties: {
    title: { type: 'string' },
    requirements: { type: 'array', items: { type: 'string' } },
    interfaces: { type: 'array', items: { type: 'string' } },
    constraints: { type: 'array', items: { type: 'string' } },
  },
} as const;

const EXTRACTION_PROMPT = `You are writing a business-level specification for a software module so that a different team could reimplement it from scratch.

Rules — these matter:
- Describe WHAT the module must do (business rules, inputs/outputs, edge cases users care about), never HOW the current code does it.
- Do NOT mention libraries, file names, variable names, design patterns, or code structure.
- Public interfaces: list the function signatures / endpoints other modules rely on, as plain contracts.
- Constraints: validation rules, error behavior, and domain rules (e.g. "a province can have multiple tax rates that must all be returned").

Module source files follow. Produce the spec as JSON.
`;

/**
 * X1: load an externally-authored spec (Linear ticket export or hand-written)
 * from `<specsDir>/<module-key>.json` — e.g. `src__services__tax.json` for
 * module `src/services/tax`. This is the honest apples-to-apples mode: the
 * baseline gets the same document the delivery pipeline consumed, with zero risk
 * of spec circularity. Returns null when no file exists for the module.
 */
export async function loadExternalSpec(module: ModuleInfo, specsDir: string): Promise<ModuleSpec | null> {
  const key = module.id.replace(/[\\/]/g, '__') || '_root';
  try {
    const raw = JSON.parse(await readFile(join(specsDir, `${key}.json`), 'utf8')) as Partial<ModuleSpec>;
    if (!raw.title || !Array.isArray(raw.requirements)) return null;
    return {
      moduleId: module.id,
      title: raw.title,
      requirements: raw.requirements,
      interfaces: raw.interfaces ?? [],
      constraints: raw.constraints ?? [],
      source: 'linear',
    };
  } catch {
    return null;
  }
}

/**
 * X1: leakage check for EXTRACTED specs — how much of the spec's vocabulary is
 * lifted straight from the code's identifiers? Public interface names are
 * expected to appear (that's the contract); a spec whose *requirements and
 * constraints* echo many internal identifiers is describing the implementation,
 * not the business need — flattering the baseline's prompt. Returns the share
 * of distinctive spec words (camelCase/snake_case, >3 chars) found among the
 * source identifiers, excluding words from the interfaces section.
 */
export function specLeakage(spec: ModuleSpec, sourceCode: string): number {
  const sourceIds = new Set((sourceCode.match(/[A-Za-z_$][\w$]{3,}/g) ?? []).map((w) => w.toLowerCase()));
  const interfaceWords = new Set(
    spec.interfaces.flatMap((i) => i.match(/[A-Za-z_$][\w$]{3,}/g) ?? []).map((w) => w.toLowerCase()),
  );
  const specWords = [...spec.requirements, ...spec.constraints, spec.title]
    .flatMap((t) => t.match(/[a-z]+[A-Z][\w$]*|[a-z]+_[\w$]+/g) ?? []) // camelCase / snake_case only
    .map((w) => w.toLowerCase())
    .filter((w) => w.length > 3 && !interfaceWords.has(w));
  if (specWords.length === 0) return 0;
  const leaked = specWords.filter((w) => sourceIds.has(w)).length;
  return leaked / specWords.length;
}

export async function extractSpec(module: ModuleInfo, repoRoot: string): Promise<ModuleSpec> {
  const sources = await Promise.all(
    module.files.slice(0, 12).map(async (f) => {
      const content = await readFile(join(repoRoot, f), 'utf8').catch(() => '');
      return `--- ${f} ---\n${content}`;
    }),
  );
  const { value } = await codexExecJson<Omit<ModuleSpec, 'moduleId' | 'source'>>(
    `${EXTRACTION_PROMPT}\n${sources.join('\n\n')}`,
    SPEC_SCHEMA,
    { cwd: repoRoot, sandbox: 'read-only' },
  );
  return { ...value, moduleId: module.id, source: 'extracted' };
}
