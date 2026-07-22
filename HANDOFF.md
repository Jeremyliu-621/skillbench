# HANDOFF — remaining work

*Started 2026-07-17. Read `CLAUDE.md` first, then this file. Check items off as you land them.*

## Current state (updated 2026-07-17, Phase 0 complete)

- ✅ Research + methodology locked: `docs/research-report.md` (don't relitigate the invariants in `docs/architecture.md` without new evidence).
- ✅ **197 tests pass, typecheck clean, 0 npm audit findings.** Clean commit history (`git log`).
- ✅ **ALL core tasks done:** proc runner, D2 scanners, D3 consistency, **D1 executed test harness** (spec-derived suite, subject-merging child runner, runs both sides differentially, feeds correctness + behavioral stability, cached by spec hash, runs even offline when cached), mapping/aggregation, P1 pipeline (full + `--offline` + resume + `--specs`), R1 HTML report, S1 cluster-aware bootstrap, J1 judge truncation, X1 external specs + leakage check.
- ✅ **Interactive agent (front door):** `2bench` with no args launches a friendly REPL (`src/repl.ts`) — banner, command list, and a Codex-backed concierge (`src/agent/concierge.ts`) that answers newcomers in plain English and *proposes* commands the user confirms before running. Slash-commands and CLI flags share one command layer (`src/commands.ts`) so they can't diverge; the concierge may only ever suggest a command in the catalog (`src/agent/catalog.ts`) — unknown suggestions are dropped, never executed. Real-Codex validated end-to-end.
- ✅ Real-Codex validation on a fixture module (see below).

## Remaining (Phase 1+, none demo-blocking)

### D4 — mutation score
Stryker (or a small built-in AST mutator) over the shared suite. Note a design subtlety discovered during build: both sides run the SAME suite, so its mutation score is a *suite-quality* indicator (confidence in the correctness verdict), not a per-side comparator — report it in meta, don't blend it into per-side correctness unless the suites diverge.

### S1b — Bayesian intervals
Paired Beta-Bernoulli / Dirichlet (win-tie-loss) credible intervals alongside Wilson; port from `bayes_evals` (github.com/sambowyer/bayes_evals). Cluster bootstrap is already in.

### J2 — judge panel (deliberately deferred)
Add a second-family judge (Claude CLI headless) with majority vote. Deferred because it bills against the user's capped Claude subscription; the engine seam (`PipelineEngine.judge`) is ready. Until then the report's argument stands: Codex judging its own baseline favors the baseline, so uplift is a conservative lower bound.

### J3 — judge batching
Batch the 4 dimensions into one call per direction (cost ÷4) — only after verifying batched verdicts match unbatched on a few real modules.

### X2 — Linear API loader ✅
`2bench linear` pulls issues via the Linear GraphQL API and writes the `--specs`
JSONs (`src/stages/linear.ts`). Decoupled loader (fetch ≠ score, so resumable/
offline-scoreable); injectable transport (unit-tested, no network, extends to
Jira/GitHub); cursor pagination; incremental `--since auto` checkpoint; 429
backoff; declarative `spec:<path>` label mapping (or a `--map` file); multiple
tickets merge into one module spec. Auth via `LINEAR_API_KEY` (env, never argv).

### D1b — suite-fidelity guard (finding from the 2026-07-17 self-run)
Scoring 2bench with itself exposed an asymmetry in D1 when specs are *extracted*:
the suite and the baseline are both synthesized from the same lossy spec text, so
they agree with each other, while the original implementation's real types/side
effects diverge (self-run: `src/report` repo 0.12 vs baseline 0.98; `src/engine`
0.41 vs 0.89 — the repo "lost" correctness to a suite that tests the paraphrase,
not the contract). The tax fixture (value-level business logic, precise spec) was
fair: 100% vs 100%. Mitigations, in order of value:
1. Real specs via `--specs` — then the suite tests the contract both sides owed.
2. Guard heuristic: when spec.source === 'extracted' AND repo pass rate is
   drastically below baseline (e.g. repo < 0.5 × baseline), mark the module's
   correctness as fidelity-suspect: drop it to the judge + warn in the report.
3. Restrict D1 to business-logic module kinds ('service'/'route'/'lib' with
   value-level interfaces); infra modules (process-spawning engines, renderers
   of rich internal types) go to the judge.
This does NOT bite the real target use case (ERP business modules + real Linear
tickets), but the guard keeps self-serve runs honest.

## Demo script

1. `2bench doctor` — show the engine + scanners that are live (install jscpd/semgrep for a richer demo).
2. `2bench score <a-real-erp-repo>` (with Linear tickets if available). Tip: start with `--sample 3` to keep the first run short; each module ≈ 1 spec + K×P regenerations + ~4 judge calls.
3. Open `report.html`: verdict band (uplift + win rate vs. the 40% gate), dimension bars, evidence-anchor cards, methodology appendix.
4. Talking points: private-repo baseline beats public benchmarks (contamination); Codex judging its own baseline biases toward the baseline, so uplift is a conservative lower bound; deterministic reruns (same seed → same score); gate uses the CI lower bound.

## Real-run validation (2026-07-17, Phase 0 complete)

The full Codex-backed pipeline ran end-to-end on a one-module fixture (a 54-line
Canadian tax module): spec extraction (business-level, no leakage warning) →
baseline regeneration (2 samples, real files, stdlib-only) → **shared test-suite
generation (22 augmented tests: error messages, case-insensitivity, independent
line rounding, fractional cents, zero/large amounts)** → suite executed against
the repo AND both candidates → deterministic scanners → consistency → swapped
judging of the residual (security only) → cluster-aware aggregation → score.json
+ report.html. All stages against real `codex exec`.

Result: correctness 100% vs 100% (both pass 22/22), maintainability/consistency
ties, security judged to the baseline; uplift ≈ 0%, gate FAIL. That is the
*correct* reading — a trivial, precisely-specified module is exactly where a
vanilla LLM ties. Expectations for a meaningful demo:
- run on realistically-sized modules (real ERP logic, real edge-case burden);
- install Semgrep — security is the dimension where vanilla LLMs measurably fail
  (~43% flaw rate on JS/Node per Veracode) and it's skipped without the scanner;
- prefer `--specs` with real tickets over extraction.

Gotchas surfaced and fixed along the way (see git log + CLAUDE.md): 30-LOC
sampling floor (tiny modules sample to 0 → health-only); agents don't reliably
write files (structured-output + we write); win32 shell quoting of exe paths
with spaces; vitest 5s default timeout vs. real child-process tests.

## Verification loop for each task

`npm run typecheck && npm test`, then a real `npm run dev -- <cmd>` against a fixture repo. Codex-dependent stages: test manually with 1 small module first (each regeneration ≈ 10–40k tokens; watch the 5-hour window).
