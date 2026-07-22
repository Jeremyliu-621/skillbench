# CLAUDE.md — 2bench

Tool that scores a codebase vs. a pure zero-shot-LLM baseline ("uplift %"). The rule it productizes (a custom-ERP agency practice): custom AI must beat zero-shot by ≥40%.

## Commands

```bash
npm run dev                              # interactive agent (default, no args): banner + command list + chat
npm run dev -- inventory <repo>          # list modules + sample preview
npm run dev -- doctor                    # engine + scanner availability
npm run dev -- score <repo>              # codebase vs pure-LLM (add --offline for no Codex)
npm run dev -- skill <bench.json>        # skill vs plain prompting
npm run dev -- history                   # uplift across runs
npm run dev -- serve                     # portfolio dashboard on localhost (loopback only)
npm test                                 # vitest; no LLM calls (fake engines)
npm run typecheck
```

The bare `2bench` command launches `src/repl.ts` (the friendly front door). Both
front-ends — flags (`cli.ts`) and chat (`repl.ts`) — call the shared command layer
in `src/commands.ts`, so they never diverge. The chat concierge (`src/agent/`) is a
proposer, not an autopilot: it can only *suggest* a catalog command, which the REPL
runs after a confirm (expensive `score`/`skill` always gated). Add new commands to
`src/agent/catalog.ts` — that one list feeds the banner, `/help`, and what the agent
is allowed to offer.

Two pipelines share every downstream stage: `pipeline.ts` (codebase: repo vs
regenerated baseline) and `skill-pipeline.ts` (skill: treatment vs control arms).
Both emit the same `RunResult`, so scoring, stats, and reports are written once.

## Read before changing anything

1. `HANDOFF.md` — current state + prioritized remaining work with acceptance criteria.
2. `docs/architecture.md` — pipeline, stage contracts, and **nine non-negotiable invariants** (seeded determinism, position-swap judging, CI-lower-bound gating, ties as ½, no naive CLT, information parity, distribution-not-mean metrics, deterministic-first, degrade-loudly). Do not simplify these away — each is evidence-forced.
3. `docs/research-report.md` — the evidence behind every design decision (cited).

## Hard-won gotchas

- **Codex CLI hangs on open stdin.** All calls go through `src/engine/codex.ts`, which passes the prompt via stdin and closes it. Never shell out to `codex` directly.
- Codex default reasoning effort is **none** — judging must pass `reasoningEffort: 'high'`.
- **Don't rely on the agent to write files.** Asked to "create files" in workspace-write, Codex often just prints the code as a message and writes nothing (empty candidate dir). Generate code via `--output-schema` as a `files[]` JSON and write it yourself (`regenerate.ts` / `writeGeneratedFiles`, with a path-traversal guard). Read-only sandbox is enough.
- Codex subscription auth shares a **5-hour rolling usage window** with the user's interactive use — long batch stages must checkpoint and resume (regenerate.ts TODO).
- Windows: `codex` is a `.cmd` shim; the shared runner (`src/engine/proc.ts`) uses `shell: true` + self-quoting (Node CVE-2024-27980). Keep prompts/untrusted input out of argv — pass via `stdin`.
- Windows timeouts must **tree-kill** (`taskkill /T`): `shell: true` means we spawn cmd.exe and the real process is a grandchild that a plain `child.kill()` orphans (it would keep running + hold pipes open). `proc.ts` handles this and resolves immediately on timeout; route all child processes through `runProcess`.
- ESM project (`"type": "module"`, NodeNext): relative imports need explicit `.js` extensions.

## Conventions

- All scores normalized to [0,1], 1 = best, so uplift math stays uniform.
- Every stochastic step takes an explicit seed (`stats/random.ts` mulberry32). Tests assert determinism.
- Stats functions are pure and LLM-free; anything calling Codex lives in `src/stages/` or `src/engine/`.
- Tests in `tests/`, no LLM calls in tests — judge logic is tested via the pure `reconcileSwappedVerdicts`.
- User runs demos on their Codex subscription (≈$0 marginal). Don't add metered-API dependencies without asking.
