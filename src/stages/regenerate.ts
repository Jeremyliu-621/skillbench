import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, sep } from 'node:path';
import type { BaselineCandidate, BenchConfig, ModuleSpec } from '../types.js';
import { codexExecJson } from '../engine/codex.js';

/**
 * Stage 3: vanilla-LLM baseline regeneration.
 *
 * We ask Codex for the implementation as STRUCTURED JSON (a files[] array via
 * --output-schema) and write the files ourselves, rather than relying on the
 * agent's sandbox file-writing. That was the original approach and it failed:
 * with default reasoning the agent emitted code as a message and wrote nothing,
 * leaving an empty candidate dir (caught in the 2026-07-17 real run). Structured
 * output is deterministic, cross-platform, and needs only a read-only sandbox.
 *
 * Fairness requirements (research-report.md §2.5):
 *  - MULTI-PROMPT: single-prompt baselines are statistically unreliable, so each
 *    spec is regenerated under P paraphrases.
 *  - MULTI-SAMPLE: K samples per prompt stabilize the estimate AND feed the
 *    consistency dimension (variance across samples = baseline instability).
 *  - ZERO CONTEXT: the generator sees ONLY the spec — no repo code, no skills,
 *    no house rules. That is what "pure LLM" means.
 */

export interface GeneratedFile {
  path: string;
  content: string;
}

/** Schema for "return an implementation as files" — shared with skill benchmarking. */
export const FILES_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['files'],
  properties: {
    files: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'repo-relative path, e.g. src/tax.ts' },
          content: { type: 'string' },
        },
      },
    },
  },
} as const;

// Stdlib-only: generated code must be executable in-place by the shared test
// harness (D1) with no install step — external deps would fail to import and
// unfairly zero the baseline's correctness.
const PROMPT_VARIANTS: readonly ((spec: ModuleSpec) => string)[] = [
  (spec) =>
    `Implement the following module in TypeScript for Node.js. Use ONLY the Node.js standard library — no external dependencies, no package.json. Export every public interface named in the spec. Return every file as a JSON object with a "files" array of {path, content}. Do not write any prose — only the JSON.\n\n${render(spec)}`,
  (spec) =>
    `You are given a software specification. Produce a complete, production-quality TypeScript (Node.js) implementation as JSON: a "files" array of {path, content} objects. Standard library only — no third-party packages. Every public interface named in the spec must be exported. Output only the JSON.\n\n${render(spec)}`,
];

function render(spec: ModuleSpec): string {
  return [
    `# ${spec.title}`,
    '## Requirements',
    ...spec.requirements.map((r) => `- ${r}`),
    '## Public interfaces',
    ...spec.interfaces.map((i) => `- ${i}`),
    '## Constraints',
    ...spec.constraints.map((c) => `- ${c}`),
  ].join('\n');
}

export async function regenerateBaseline(
  spec: ModuleSpec,
  workRoot: string,
  config: BenchConfig,
): Promise<BaselineCandidate[]> {
  const candidates: BaselineCandidate[] = [];
  const paraphrases = Math.min(config.baseline.promptParaphrases, PROMPT_VARIANTS.length);

  for (let promptIndex = 0; promptIndex < paraphrases; promptIndex++) {
    for (let sampleIndex = 0; sampleIndex < config.baseline.samplesPerSpec; sampleIndex++) {
      const dir = join(
        workRoot,
        'baseline',
        spec.moduleId.replace(/[\\/]/g, '__'),
        `p${promptIndex}-s${sampleIndex}`,
      );
      await mkdir(dir, { recursive: true });

      const { value, result } = await codexExecJson<{ files: GeneratedFile[] }>(
        PROMPT_VARIANTS[promptIndex]!(spec),
        FILES_SCHEMA,
        { cwd: dir, sandbox: 'read-only', model: config.baseline.model ?? undefined },
      );
      await writeGeneratedFiles(dir, value.files ?? []);

      candidates.push({
        moduleId: spec.moduleId,
        sampleIndex,
        promptIndex,
        dir,
        tokensUsed: result.tokens.input + result.tokens.output,
      });
    }
  }
  return candidates;
}

/** Write generated files under `dir`, refusing any path that escapes it. */
export async function writeGeneratedFiles(dir: string, files: readonly GeneratedFile[]): Promise<number> {
  let written = 0;
  const root = normalize(dir + sep);
  for (const file of files) {
    const rel = normalize(file.path).replace(/^([/\\])+/, '');
    const target = normalize(join(dir, rel));
    if (!target.startsWith(root)) continue; // path-traversal guard on model output
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, 'utf8');
    written++;
  }
  return written;
}
