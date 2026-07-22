import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import ts from 'typescript';
import { COMPLEXITY_UNHEALTHY } from './normalize.js';

/**
 * Always-available maintainability signal: per-function cyclomatic complexity via
 * the TypeScript compiler API (no external tool — works on any machine, so the
 * demo always has a maintainability number).
 *
 * We deliberately score the DISTRIBUTION, not a mean: the metric is the share of
 * code (by LOC) that lives in "healthy" files, because software metrics follow a
 * power law and an average hides the few pathological files that actually hurt
 * (research-report.md §2.3, Maintainability-Index critique).
 */

export interface FunctionComplexity {
  name: string;
  complexity: number;
  loc: number;
}

export interface FileComplexity {
  file: string;
  loc: number;
  maxComplexity: number;
  functions: FunctionComplexity[];
}

export interface ComplexityReport {
  files: FileComplexity[];
  totalLoc: number;
  /** Share of LOC in files whose max function complexity is below the threshold. */
  healthShare: number;
}

const SOURCE_RE = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.2bench']);

/** Cyclomatic complexity of a single source string (1 + count of branch points). */
export function complexityOfSource(source: string, fileName = 'x.ts'): FileComplexity {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const functions: FunctionComplexity[] = [];

  const visitFunctionLike = (node: ts.Node, name: string): void => {
    let complexity = 1;
    const countBranches = (n: ts.Node): void => {
      switch (n.kind) {
        case ts.SyntaxKind.IfStatement:
        case ts.SyntaxKind.ForStatement:
        case ts.SyntaxKind.ForInStatement:
        case ts.SyntaxKind.ForOfStatement:
        case ts.SyntaxKind.WhileStatement:
        case ts.SyntaxKind.DoStatement:
        case ts.SyntaxKind.CaseClause:
        case ts.SyntaxKind.CatchClause:
        case ts.SyntaxKind.ConditionalExpression:
          complexity++;
          break;
        case ts.SyntaxKind.BinaryExpression: {
          const op = (n as ts.BinaryExpression).operatorToken.kind;
          if (
            op === ts.SyntaxKind.AmpersandAmpersandToken ||
            op === ts.SyntaxKind.BarBarToken ||
            op === ts.SyntaxKind.QuestionQuestionToken
          ) {
            complexity++;
          }
          break;
        }
      }
      // Don't descend into nested function bodies — they get their own entry.
      if (!isFunctionLike(n) || n === node) ts.forEachChild(n, countBranches);
    };
    ts.forEachChild(node, countBranches);
    const loc = node.getText(sf).split('\n').filter((l) => l.trim()).length;
    functions.push({ name, complexity, loc });
  };

  const walk = (node: ts.Node): void => {
    if (isFunctionLike(node)) {
      visitFunctionLike(node, functionName(node));
    }
    ts.forEachChild(node, walk);
  };
  walk(sf);

  const loc = source.split('\n').filter((l) => l.trim()).length;
  const maxComplexity = functions.reduce((m, f) => Math.max(m, f.complexity), 0);
  return { file: fileName, loc, maxComplexity, functions };
}

export function isFunctionLike(node: ts.Node): boolean {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  );
}

function functionName(node: ts.Node): string {
  const named = node as ts.FunctionDeclaration;
  if (named.name && ts.isIdentifier(named.name)) return named.name.text;
  // Arrow/function expressions take the name they're bound to:
  //   const inner = (x) => …   |   obj = { inner: () => … }
  const parent = node.parent;
  if (parent && ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  if (parent && ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) return parent.name.text;
  return '<anonymous>';
}

/** Aggregate a healthShare over a whole directory tree. */
export async function analyzeComplexity(dir: string): Promise<ComplexityReport> {
  const files: FileComplexity[] = [];
  for (const file of await collectSourceFiles(dir)) {
    const content = await readFile(file, 'utf8').catch(() => '');
    if (!content.trim()) continue;
    try {
      files.push(complexityOfSource(content, file));
    } catch {
      // Unparseable file: skip rather than crash the run.
    }
  }
  return summarize(files);
}

export function summarize(files: FileComplexity[]): ComplexityReport {
  const totalLoc = files.reduce((s, f) => s + f.loc, 0);
  const healthyLoc = files
    .filter((f) => f.maxComplexity < COMPLEXITY_UNHEALTHY)
    .reduce((s, f) => s + f.loc, 0);
  return {
    files,
    totalLoc,
    healthShare: totalLoc === 0 ? 1 : healthyLoc / totalLoc,
  };
}

export async function collectSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const rootStat = await stat(dir).catch(() => null);
  if (!rootStat) return out;
  if (rootStat.isFile()) return SOURCE_RE.test(dir) ? [dir] : out;

  const walk = async (d: string): Promise<void> => {
    const entries = await readdir(d, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      if (e.isDirectory()) {
        if (SKIP.has(e.name) || e.name.startsWith('.')) continue;
        await walk(join(d, e.name));
      } else if (e.isFile() && SOURCE_RE.test(e.name) && !/\.(test|spec)\./.test(e.name)) {
        out.push(join(d, e.name));
      }
    }
  };
  await walk(dir);
  return out;
}
