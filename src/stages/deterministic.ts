import type { DeterministicScores } from '../types.js';
import { commandExists, runProcess } from '../engine/proc.js';
import { analyzeComplexity, type ComplexityReport } from '../scanners/complexity.js';
import { runDuplication, type DuplicationResult } from '../scanners/duplication.js';
import { runLint, type LintResult } from '../scanners/lint.js';
import { runSecrets, type SecretsResult } from '../scanners/secrets.js';
import { applySecretPenalty, runSecurity, type SecurityResult } from '../scanners/security.js';

/**
 * Stage 4: deterministic scoring — the reproducible, LLM-free layer that carries
 * most of the score (deterministic-first doctrine).
 *
 * Complexity/maintainability is ALWAYS available (TS compiler API, no external
 * tool). Duplication, security, secrets, and lint are best-effort: a missing tool
 * yields a `null` sub-score plus an entry in `unavailable` — surfaced in the
 * report, never a silent 0 or a crash (invariant 9: degrade loudly).
 *
 * Still open: testPassRate (D1 — shared spec-derived suite) and mutationScore
 * (D4). Both stay null until wired. `stability` is populated at the candidate-set
 * level by the consistency stage, not here.
 */

export interface ScanDetail {
  complexity: ComplexityReport;
  duplication: DuplicationResult | null;
  security: SecurityResult | null;
  secrets: SecretsResult | null;
  lint: LintResult | null;
  loc: number;
  unavailable: string[];
}

export interface DeterministicResult {
  scores: DeterministicScores;
  detail: ScanDetail;
}

/** Which optional scanners are usable. Detect ONCE per run (detectCapabilities)
 *  and thread through, rather than inferring availability from a scanner's exit
 *  code — a missing binary under the win32 shell exits non-zero instead of
 *  throwing, which would otherwise be misread as "ran, found nothing". */
export interface Capabilities {
  jscpd: boolean;
  semgrep: boolean;
  gitleaks: boolean;
  eslint: boolean;
}

export async function detectCapabilities(): Promise<Capabilities> {
  const tools = await detectTools();
  const has = (name: string) => tools.find((t) => t.name === name)?.found ?? false;
  return {
    jscpd: has('jscpd'),
    semgrep: has('semgrep'),
    gitleaks: has('gitleaks'),
    eslint: has('eslint'),
  };
}

/** Score one implementation directory (a repo module or a baseline candidate).
 *  Pass `caps` to avoid re-detecting tools per module; omitted → detect once. */
export async function scoreImplementation(dir: string, caps?: Capabilities): Promise<DeterministicResult> {
  const capabilities = caps ?? (await detectCapabilities());
  const complexity = await analyzeComplexity(dir);
  const loc = complexity.totalLoc;

  const [duplication, securityRaw, secrets, lint] = await Promise.all([
    capabilities.jscpd ? runDuplication(dir) : Promise.resolve(null),
    capabilities.semgrep ? runSecurity(dir, loc) : Promise.resolve(null),
    capabilities.gitleaks ? runSecrets(dir) : Promise.resolve(null),
    capabilities.eslint ? runLint(dir, loc) : Promise.resolve(null),
  ]);

  // Fold hardcoded secrets into the security score when both scanners ran.
  const security =
    securityRaw && secrets ? applySecretPenalty(securityRaw, secrets.count, loc) : securityRaw;

  const unavailable: string[] = [];
  if (!capabilities.jscpd) unavailable.push('jscpd (duplication)');
  if (!capabilities.semgrep) unavailable.push('semgrep (security)');
  if (!capabilities.gitleaks) unavailable.push('gitleaks (secrets)');
  if (!capabilities.eslint) unavailable.push('eslint (lint)');

  const scores: DeterministicScores = {
    testPassRate: null,
    mutationScore: null,
    security: security?.score ?? null,
    duplication: duplication?.score ?? null,
    complexityHealth: complexity.healthShare,
    lintCleanliness: lint?.score ?? null,
    secretCount: secrets?.count ?? null,
    stability: null,
  };

  return { scores, detail: { complexity, duplication, security, secrets, lint, loc, unavailable } };
}

export interface ToolAvailability {
  name: string;
  found: boolean;
  version?: string;
  required: boolean;
  dimension: string;
}

/** Real availability probes surfaced by `2bench doctor`. */
export async function detectTools(): Promise<ToolAvailability[]> {
  const probes: { name: string; versionArg: string; dimension: string }[] = [
    { name: 'semgrep', versionArg: '--version', dimension: 'security' },
    { name: 'gitleaks', versionArg: 'version', dimension: 'security (secrets)' },
    { name: 'stryker', versionArg: '--version', dimension: 'correctness (mutation)' },
  ];
  const results = await Promise.all(
    probes.map(async (p) => {
      const version = await commandExists(p.name, p.versionArg);
      return { name: p.name, found: version !== null, version: version ?? undefined, required: false, dimension: p.dimension };
    }),
  );
  // jscpd and eslint run via npx (may be project-local); probe without installing.
  for (const npxTool of [
    { name: 'jscpd', dimension: 'maintainability (duplication)' },
    { name: 'eslint', dimension: 'maintainability (lint)' },
  ]) {
    const version = await npxVersion(npxTool.name);
    results.push({
      name: npxTool.name,
      found: version !== null,
      version: version ?? undefined,
      required: false,
      dimension: npxTool.dimension,
    });
  }
  return results;
}

async function npxVersion(tool: string): Promise<string | null> {
  try {
    const { stdout, exitCode } = await runProcess('npx', ['--no-install', tool, '--version'], {
      timeoutMs: 60_000,
    });
    return exitCode === 0 ? stdout.trim().split('\n')[0] ?? '' : null;
  } catch {
    return null;
  }
}
