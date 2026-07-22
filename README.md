# 2bench

**Scores any codebase against a pure-LLM baseline** — answering, with a defensible percentage: *"how much better is this code than what a zero-shot LLM (no skills, no context, no pipeline) would have produced?"*

> 📖 **New here? Start with [docs/how-it-works.md](docs/how-it-works.md)** — the whole project explained from zero, no jargon, in ten minutes.

Built around a custom-ERP agency methodology, where custom AI skills must beat zero-shot prompts by **≥40%** to justify their existence. 2bench generalizes that rule from individual skills to whole codebases, producing both a CI quality gate and a client-facing report.

## How it works

```
repo ──► inventory ──► stratified sample (10–30 modules, seeded)
              │
              ├──► spec extraction (Linear tickets preferred; code-derived fallback)
              │         │
              │         ▼
              │    vanilla-LLM regeneration (Codex CLI, K samples × P prompts, zero context)
              │         │
              ▼         ▼
        deterministic scoring (both sides, identical harness):
        spec-derived augmented tests · Semgrep · gitleaks · jscpd · ESLint · Stryker
              │
              ▼
        pairwise LLM judging (residual dimensions only; position-swapped, high reasoning)
              │
              ▼
        statistics (paired, small-N-honest: Wilson + seeded bootstrap, ties counted)
              │
              ├──► score.json + exit code   (CI gate: CI lower bound ≥ 40%)
              └──► report.html              (client-facing)
```

Two headline numbers:
- **Win rate** — share of head-to-head comparisons the repo won (ties = ½), with a Wilson confidence interval.
- **Uplift** — weighted relative improvement over the baseline per dimension (correctness 40% / security 25% / maintainability 20% / consistency 15%, configurable and always disclosed), with a bootstrap CI. The gate passes only if the CI **lower bound** clears the threshold.

Every methodological choice is evidence-backed — see [docs/research-report.md](docs/research-report.md) for the research (verified citations) and [docs/architecture.md](docs/architecture.md) for the design.

## Two things it can score

**A codebase** (`score`) — how much better is this code than a zero-shot LLM's rebuild of the same specs?

**A skill** (`skill`) — does a custom skill/prompt actually beat plain prompting? Same machinery one level up: each task runs twice through the same model, once with the skill and once without, and the skill text is the *only* difference between the arms. This is the measurement layer a shared skill library needs — see [`examples/tax-skill.bench.json`](examples/tax-skill.bench.json).

```jsonc
{
  "name": "Canadian tax module skill",
  "skill": "House rules the skill teaches…",   // or "skillFile": "skill.md"
  "tasks": [
    { "id": "tax-rates", "outputKind": "code", "prompt": "Write a module that…" }
  ]
}
```

## Tracking it over time

The vanilla-LLM baseline is a **moving target** — as frontier models improve, holding your uplift steady means your pipeline improved too. Every run appends to `history.jsonl`, `2bench history` prints the trend, and the report charts it. Runs record which baseline model produced them, so a drop after a model upgrade is flagged as a capability shift rather than a pipeline regression.

## Usage

**Just run `2bench` with no arguments** to start the interactive agent — a banner, the full command list, and a chat prompt. Newcomers can ask it what to do in plain English; it answers and offers to run the right command (cheap commands run instantly and free; the expensive `score`/`skill` runs only ever fire after you confirm). Power users can drive it directly with slash-commands.

```bash
npm install
npm run dev                                      # ← the interactive agent (default)
```

```
  2 B E N C H
  Does your codebase beat a zero-shot LLM?

  2bench ▸ is my repo any good?
  (thinking…)

  I can measure that: it compares your code against what a plain zero-shot LLM
  would build from the same specs. Want me to start by checking the engine is ready?

  Suggested: /doctor  — verifies Codex and the scanners before a full run.
  Run /doctor now? [Y/n]
```

Every command is also a plain flag for scripting / CI:

```bash
npm run dev -- inventory <path-to-repo>          # list modules + preview the evaluation sample
npm run dev -- doctor                            # check codex CLI + scanner availability
npm run dev -- score <path-to-repo>              # full evaluation → score.json + report.html
npm run dev -- score <path-to-repo> --offline    # zero Codex calls (deterministic/health only)
npm run dev -- skill <bench.json>                # score a SKILL against plain prompting
npm run dev -- history                           # how uplift has moved across runs
npm run dev -- serve                             # portfolio dashboard on localhost (loopback only)
```

Useful flags: `--sample <n>` (modules to sample), `--seed <n>`, `--config <path>`, `--out <dir>`, `--specs <dir>` (externally-authored specs — the honest apples-to-apples mode).

Requires Node ≥ 20 and the [OpenAI Codex CLI](https://developers.openai.com/codex) (`npm i -g @openai/codex`, authenticated) as the generation/judging engine — flat-subscription usage makes demo runs ≈ $0 marginal. Optional scanners (`doctor` lists them): jscpd, ESLint, Semgrep, gitleaks — each missing one skips its sub-score rather than failing.

## Status

**Phase 0 complete — all four dimensions measured.** Inventory + stratified sampling, seeded statistics (Wilson / cluster-aware bootstrap / gate), Codex headless engine, deterministic scanners (complexity built-in + jscpd/semgrep/gitleaks/eslint), **executed spec-derived test suites (correctness)**, baseline consistency, position-swapped judging for the residual, full pipeline (`score` with `--offline`, resume, `--specs`), and the client-facing HTML report. Remaining Phase-1 items (judge panel, Bayesian intervals, mutation, Linear API loader) are in [HANDOFF.md](HANDOFF.md).

```bash
npm test          # 170 tests
npm run typecheck
```

## Repository map

| Path | What |
|---|---|
| `src/cli.ts` | Thin flag-based entry (`inventory`, `doctor`, `score`, `skill`, `history`, `serve`) over `commands.ts` |
| `src/repl.ts` | Interactive agent — banner, command list, chat loop; `2bench` with no args ✅ |
| `src/commands.ts` | The command layer both front-ends share (so flags and chat never diverge) ✅ |
| `src/agent/` | Command catalog (single source of truth) + the Codex-backed concierge ✅ |
| `src/pipeline.ts` | Codebase orchestration (DI engine, checkpoint/resume, offline, external specs) ✅ |
| `src/skill-pipeline.ts` | Skill orchestration — treatment vs control arms, reuses all scoring/stats ✅ |
| `src/history.ts` | Append-only run history + trend summary ✅ |
| `src/stages/` | inventory ✅, spec-extract + leakage check ✅, regenerate (structured-output) ✅, testgen (D1 shared suites) ✅, deterministic scanners ✅, judge + truncation ✅, mapping ✅ |
| `src/harness/` | subject-merging child test runner (D1) ✅ |
| `src/scanners/` | complexity (built-in) ✅, duplication/security/secrets/lint ✅, consistency ✅ |
| `src/engine/` | `codex.ts` headless driver + `proc.ts` shared runner (tree-kill on timeout) ✅ |
| `src/stats/` | Wilson / seeded bootstrap / dimension aggregation + gate ✅ |
| `src/report/` | score.json ✅ · console summary ✅ · report.html (+ trend chart) ✅ |
| `examples/` | Example skill bench file |
| `2bench.config.json` | Weights, threshold, sampling, judge settings |
| `docs/research-report.md` | The research behind every design decision (cited) |
| `docs/architecture.md` | Pipeline, stage contracts, and the 9 invariants |
| `HANDOFF.md` | Current state + remaining Phase-1 work |

✅ implemented & tested
