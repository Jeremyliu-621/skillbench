import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { SkillTask } from '../types.js';
import { codexExec, codexExecJson } from '../engine/codex.js';
import { FILES_SCHEMA, writeGeneratedFiles, type GeneratedFile } from './regenerate.js';
import { collectSourceFiles } from '../scanners/complexity.js';

/**
 * Runs one ARM of a skill benchmark for one task.
 *
 *   treatment = skill text + task prompt   (what the skill claims to improve)
 *   control   = task prompt alone          (plain zero-shot prompting)
 *
 * The ONLY difference between arms is the skill text — same model, same
 * sampling, same output contract — so any measured gap is attributable to the
 * skill rather than to scaffolding. That's the information-parity rule from the
 * codebase scorer applied one level up.
 *
 * Code tasks return files via structured output and we write them ourselves
 * (agents don't reliably write files — see regenerate.ts); text tasks return
 * the final message.
 */

export type Arm = 'treatment' | 'control';

export interface ArmOutput {
  taskId: string;
  arm: Arm;
  sampleIndex: number;
  /** Directory of written files for code tasks; null for text tasks. */
  dir: string | null;
  /** The output as text — file contents concatenated, or the message itself.
   *  This is what the judge sees. */
  text: string;
  tokensUsed: number;
}

export function buildArmPrompt(task: SkillTask, skill: string | null): string {
  const isCode = (task.outputKind ?? 'code') === 'code';
  const contract = isCode
    ? 'Return every file your solution needs as JSON: a "files" array of {path, content}. Use only the Node.js standard library — no external dependencies. Output only the JSON.'
    : '';
  // Skill first, then the task — the skill is context, not an override of the ask.
  return [skill ? `${skill}\n\n---\n` : '', task.prompt, contract ? `\n\n${contract}` : '']
    .join('')
    .trim();
}

export async function runArm(
  task: SkillTask,
  arm: Arm,
  skill: string | null,
  sampleIndex: number,
  workRoot: string,
  model?: string,
): Promise<ArmOutput> {
  const dir = join(workRoot, task.id.replace(/[\\/]/g, '__'), arm, `s${sampleIndex}`);
  await mkdir(dir, { recursive: true });
  const prompt = buildArmPrompt(task, skill);
  const isCode = (task.outputKind ?? 'code') === 'code';

  if (!isCode) {
    const result = await codexExec(prompt, { cwd: dir, sandbox: 'read-only', model });
    return {
      taskId: task.id,
      arm,
      sampleIndex,
      dir: null,
      text: result.finalMessage,
      tokensUsed: result.tokens.input + result.tokens.output,
    };
  }

  const { value, result } = await codexExecJson<{ files: GeneratedFile[] }>(
    prompt,
    FILES_SCHEMA,
    { cwd: dir, sandbox: 'read-only', model },
  );
  await writeGeneratedFiles(dir, value.files ?? []);
  return {
    taskId: task.id,
    arm,
    sampleIndex,
    dir,
    text: await readDirText(dir),
    tokensUsed: result.tokens.input + result.tokens.output,
  };
}

/** Concatenate a directory's source files (sorted) — what the judge reads. */
export async function readDirText(dir: string): Promise<string> {
  const files = (await collectSourceFiles(dir)).sort();
  const parts = await Promise.all(
    files.map(async (f) => `--- ${f.split(/[\\/]/).pop()} ---\n${await readFile(f, 'utf8').catch(() => '')}`),
  );
  return parts.join('\n\n');
}
