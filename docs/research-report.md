# 2bench — Research Report & Build Proposal

**Goal:** a tool that takes any codebase and outputs a defensible percentage for *"how much better is this than what a pure (zero-shot, no-skills) LLM would have produced?"* — generalizing an agency's internal "skills must beat zero-shot by ≥40%" rule into a product.

**Design direction (agreed):** hybrid sampling · Codex CLI as the $0-marginal-cost engine for the demo · dual output (CI gate + client-facing report) · four dimensions: correctness & tests, security & compliance, maintainability & architecture, consistency & determinism.

*Method note: findings below come from a multi-agent research sweep (26 sources, 129 extracted claims, 25 adversarially verified: 14 confirmed, 4 refuted, 7 unverified because the verification run hit the Claude monthly spend limit). Claims marked ⚠ are from primary sources but did not complete adversarial verification.*

---

## 1. TL;DR recommendation

Build a CLI (`2bench score <repo>`) with a **deterministic-first, judge-second** pipeline:

1. **Inventory** the repo, pick a stratified sample of 10–30 modules.
2. **Extract specs** for sampled modules (use real Linear tickets when available; extract from code only as fallback).
3. **Regenerate** each spec with vanilla Codex (`codex exec` in a bare scratch dir, K=3 samples × 2 prompt paraphrases).
4. **Score both sides identically** with deterministic harnesses: shared spec-derived test suite (augmented inputs), Semgrep + ESLint + secret scan + duplication + complexity distribution.
5. **LLM-judge only the residual** (architecture/readability) with pairwise, position-swapped, high-reasoning judging in structured JSON.
6. **Aggregate** with paired statistics built for small samples (Wilson / paired-Bayesian intervals, ties counted) into a headline **Uplift Score** with a confidence interval, plus a per-dimension breakdown.
7. Emit `score.json` (+ exit code for CI gating at the 40% threshold) and `report.html` (client-facing).

Nearly every design choice above is forced by evidence — details and citations below.

---

## 2. What the research says, mapped to design decisions

### 2.1 Correctness: execution beats opinion, and thin test suites lie

- **Thin test suites systematically overestimate LLM code correctness.** HumanEval+ (80× more test inputs) cut measured pass@k by up to **19.3–28.9 %** across 26 LLMs — GPT-4's pass@1 fell from 88.4 → 76.2 [EvalPlus, NeurIPS 2023, verified 3-0]. Under-tested comparisons can even **flip rankings** between systems. → Our correctness harness must *generate augmented test inputs from the spec*, not just reuse the repo's existing tests.
- **Don't treat the repo's code as an infallible oracle.** EvalPlus found defects in 11 % of HumanEval's own ground-truth solutions. → Run the shared test suite against **both** implementations (differential testing); when they disagree, the test verdict decides, not "repo wins by default".
- **HumanEval-style function benchmarks are saturated** (>90 % for frontier models) and can't discriminate; repo-level tasks (SWE-bench style) still show large headroom (~30–50 % resolve rates with heavy scaffolding). → Evaluate at **module level with real specs**, the same altitude as SWE-bench Verified — the citable industry standard for repo-level evaluation.
- **Contamination inflates public-benchmark scores.** On fresh, decontaminated SWE-rebench tasks, DeepSeek-V3 dropped 35.2 % → 21.9 % and GPT-4.1 31.1 % → 26.7 % vs. SWE-bench Verified [verified 2-1]. → Regenerating a client's **private** modules is *more* defensible than any public benchmark baseline — a genuine marketing point for the tool.
- **pass@k mechanics are reusable:** the unbiased combinatorial estimator (pass@k = 1 − C(n−c,k)/C(n,k)), temperature 0–0.2 for pass@1-style reliability runs, higher for diversity sampling.

### 2.2 LLM-as-judge: pairwise, position-swapped, reasoning-on, never solo-scored

All verified 3-0 unless noted:

- **Pairwise beats pointwise rubric scoring** for code: ~50 % of pointwise judgments produce ties that can't discriminate. Binary/pairwise verdicts are more reliable than fine-grained numeric scores. → The judge never emits "this repo is 7/10"; it answers "A or B (or tie), with reasons" many times, and the *aggregation* produces the percentage.
- **Position bias is severe and unfixable by calibration:** swapping answer order changes judge accuracy by up to 14 points; even top judges flip verdicts in ~18 % of swapped pairs (position consistency ≈ 0.82); bias direction varies *per task/dataset*, so you cannot correct it once and reuse the correction. → **Every comparison runs twice with order swapped**; disagreement = tie. Report bias sensitivity alongside results (explicit best-practice recommendation of the SE judging literature).
- **Judging is least reliable exactly where our 40 % threshold decision lives** — when candidates are close in quality. → Near the threshold, more samples + wider intervals; the gate uses the CI lower bound, not the point estimate.
- **Reasoning models are dramatically better code judges**: non-thinking judges score <60 % accuracy (≈ random); small thinking models beat fine-tuned 70B judge models. Our local sanity run showed Codex defaults to `reasoning effort: none`. → Judge calls must set high reasoning effort (`-c model_reasoning_effort="high"`).
- **Self-preference bias — works in our favor here:** GPT-4 showed the largest self-preference bias (0.520) among 8 judges [verified 2-1]. Codex judging "the delivered code vs. Codex-generated baseline" will, if anything, favor **its own baseline** — so any measured uplift is a *conservative lower bound*. This is a defensibility argument worth stating in the report. For production, add a second-family judge (Claude) as a panel; majority voting across capable judges is an effective mitigation (works for >95 % of instances).
- Best frontier judges top out ≈ 82 % accuracy on hard code pairs — one more reason the deterministic layers (tests, scanners) carry most of the score and the judge only covers what can't be executed.

### 2.3 Static metrics: use them, but only the ones that survive scrutiny

- **SonarQube-style rule violations are weak quality signals on their own**: chance-level fault prediction (AUC ≈ 50 %) as individual ML features [verified 2-0]; ⚠ SonarQube metrics were the *worst* family for fault-inducing-commit prediction (~60 %) vs. process metrics (~90 %); ⚠ SonarQube's Technical Debt Ratio at default threshold performed *worse than random* (F0.5 = 0.12) at flagging unmaintainable files.
- ⚠ **CodeScene's Code Health approach** (rule-based composite validated against ~2,000 professional assessments) matched ML accuracy and beat the average human expert (F1 0.96 vs 0.88) — the model to imitate: a small set of *validated* signals, not hundreds of noisy rules.
- **The Maintainability Index is indefensible as a headline metric**: 1992 regression on tiny C/Pascal programs, never statistically significant, size-confounded, thresholds unjustified — avoid it anywhere a client statistician might look.
- **Don't average metrics across modules** — software metrics follow power-law distributions; averages hide the outliers that actually hurt. → Score the *distribution* (e.g., % of code in unhealthy files), not the mean.
- ⚠ **Mutation score is the strongest validated test-quality proxy**: mutant detection correlates with real-fault detection even after controlling for coverage, and beats raw statement coverage (canonical study: 357 real faults, 230k mutants — Just et al., FSE 2014). Caveat: ~17 % of real faults (algorithm-level) aren't coupled to mutants. → Weight mutation score above coverage in the tests sub-score (Stryker runs free).
- **Precedent for reference-free multi-dimension scoring exists** (RACE benchmark: readability/maintainability/correctness/efficiency via static analysis) — citable, and its data shows correctness-equal models differing by 5+ points on modularity/comments, proving the extra dimensions add real signal.

### 2.4 Baseline anchors: the measured gap between vanilla-LLM and engineered code

These published numbers justify the tool's premise and calibrate expectations:

| Anchor | Number | Source |
|---|---|---|
| Zero-shot LLM code with an OWASP Top-10 flaw | **~45 %** of tasks (flat since 2024; syntax pass rose 50→95 % while security stayed ~55 %) | Veracode GenAI reports 2025/2026 |
| JavaScript/Node security pass rate (a typical agency stack) | **~57 %** (≈ 43 % flaw-introduction rate) | Veracode |
| Worst CWE classes | XSS ~13–15 % pass, log injection ~12–13 % pass (sanitization needs dataflow knowledge zero-shot LLMs lack) | Veracode |
| Copilot code with vulnerabilities (CodeQL + manual, MITRE top-25 scenarios) | **~40 %** — top-confidence suggestions nearly as bad (39.3 %) | "Asleep at the Keyboard", CACM |
| Copy/pasted line share 2021→2024 (AI-assistant era) | **8.3 % → 12.3 %**; refactoring-linked lines 25 % → <10 %; 4× clone-block growth; 2024 first year copy/paste exceeded moved code | GitClear (211M changed lines) |
| Model size/newness fixes security? | **No** — pass rates flat across sizes (small/medium/large all ≈ 51 %); reasoning models only partial exception (70–72 %) | Veracode |

Two useful implications: (a) "vanilla LLM" is a fairly **stable baseline** for security (it isn't improving much), which protects the score's shelf life; (b) the security dimension should **weight CWE classes unevenly** (an XSS finding is far more diagnostic of vanilla-LLM-ness than a crypto finding).

### 2.5 Statistics: how to make one honest percentage out of all this

- **Paired design, always.** Compare repo vs. baseline *on the same module* and analyze per-module paired differences — positive correlation between paired scores gives free variance reduction [Anthropic, "Adding Error Bars to Evals"].
- **Naive CLT error bars are indefensible at our N.** With 10–50 sampled modules, mean ± 1.96·SE under-covers, can exceed [0,1] or collapse to zero width. Use **Wilson score intervals** for win rates and **paired Bayesian (Beta-Bernoulli) intervals** for the head-to-head difference; hierarchical/clustered models if multiple modules come from one subsystem (clustered SEs can be >3× naive). Open-source implementation exists (`bayes_evals`) [verified 3-0 set].
- **Model ties explicitly** — ~20 % of pairwise outcomes in the largest human-preference dataset (Chatbot Arena, 1.37M comparisons) are ties; win/loss-only schemes distort. Count a tie as ½ win or report three-way.
- **Bradley-Terry, not online Elo**, if we ever rank >2 systems (batch, order-independent, bootstrap CIs) — for the two-system case, win rate + Wilson CI is enough.
- **Sample size is computable, not guessed**: the power-analysis formula n = (z_α/2+z_β)²(ω²+σ²_A/K_A+σ²_B/K_B)/δ² tells us how many modules must be sampled to detect a 40 % uplift with chosen power. Ballpark: a clear gap needs ~10 modules; a close call needs 30+.
- **Multi-prompt + multi-sample regeneration is mandatory for fairness**: single-prompt evaluation is unreliable (model ranks swing wildly with wording — verified 2-1), and repeated sampling per item stabilizes both the score and feeds the consistency dimension (K regenerations per spec; SWE-rebench protocol: 5 runs + SEM, fixed scaffold).

### 2.6 The headline score — proposed definition

Report **two numbers, one gate**:

1. **Head-to-head win rate** (client-friendly): across all (module × dimension) position-swapped comparisons — "*the delivered codebase beat the pure-LLM baseline in 87 % of 240 head-to-head checks (95 % CI 81–91 %)*". Wilson CI. Ties counted as ½.
2. **Relative uplift** (the 40 %-rule number): per dimension d, U_d = (S_repo,d − S_base,d) / S_base,d on deterministic sub-scores (test pass rate on the augmented shared suite, weighted-finding density inverted, healthy-code share, stability index). Headline U = Σ w_d·U_d with default weights **correctness .40 / security .25 / maintainability .20 / consistency .15** (configurable, always printed). CI by bootstrap over modules.
3. **CI gate**: pass iff the *lower bound* of U's interval ≥ 40 % (threshold configurable). Exit code + `score.json`.

### 2.7 Codex CLI as the engine — verified locally + documented caveats

Verified on this machine (codex-cli 0.144.5): `codex exec` headless works; `--json` JSONL event stream with token usage; `--output-schema` forces judge verdicts into validated JSON; `-o` captures the final message; sandbox levels `read-only` / `workspace-write`; `--skip-git-repo-check` + `-C` for scratch-dir regeneration; `--ephemeral` for no session persistence. **Gotcha found in testing: it blocks on piped stdin — every scripted call needs stdin closed (`< /dev/null`).** Default reasoning effort is *none* — must raise it for judging.

Subscription-cost reality (from OpenAI docs + practitioner CI guides): ChatGPT-plan auth draws from a **5-hour rolling usage window shared with interactive use**, and cached credentials on ephemeral runners expire after ~8 days. So: **$0 marginal for the local demo — real, but rate-limited**; production CI wants API-key auth (metered) — at typical volumes (see §4) that lands in the $5–20/run band already agreed.

---

## 3. Prior art & differentiation

*(Coverage note: the competitor angle got the least verified-source coverage in the sweep; this section is informed judgment, not verified citation.)*

- **Absolute code graders** (SonarQube/SonarCloud, Codacy, CodeScene, Code Climate): score a codebase against fixed rules/health models. None answer the **counterfactual** question — "vs. what an LLM would have done."
- **LLM-app eval harnesses** (DeepEval, Braintrust, LangSmith, OpenAI Evals): evaluate *prompts/agents/models*, not delivered codebases.
- **Model benchmarks** (SWE-bench, LiveCodeBench, EvalPlus): rank *models* on public tasks; contaminated for baseline purposes and not about a specific repo.
- **2bench's unique position:** counterfactual, repo-specific, evidence-anchored uplift measurement — effectively productizing an agency's ≥40 % rule. Nearest conceptual neighbor is pairwise arena-style evaluation (Chatbot Arena / AlpacaEval), applied for the first time (as far as the sweep found) to *whole delivered codebases vs. a regenerated baseline*.

Differentiators to lean on: (1) private-code baseline = contamination-free by construction; (2) deterministic-first scoring = reproducible and audit-friendly (a deterministic-first doctrine, SOC2-compatible); (3) statistics designed for small N with honest intervals — most competing "scores" ship a bare number.

---

## 4. Cost & scalability model

| Stage | Engine | Cost (demo) | Cost (prod API) |
|---|---|---|---|
| Inventory, sampling, static scans, tests, stats | Local deterministic tools | $0 | $0 |
| Spec extraction (15 modules) | Codex | subscription | ~$0.5–2 |
| Regeneration (15 × K=3 × 2 prompts) | Codex | subscription | ~$3–10 |
| Judging (15 × 4 dims × 2 swaps, batched) | Codex (+Claude panel later) | subscription | ~$2–8 |
| **Total per full run** | | **$0 marginal** | **~$5–20** ✓ target band |

Scalability levers: cache by content hash (unchanged module ⇒ reuse verdicts — mirrors the determinism principle); incremental mode in CI (only changed modules re-scored); sample size auto-tuned by the power formula (clear gaps need fewer modules); deterministic layers always run repo-wide (cheap), regeneration only on the sample.

---

## 5. Threats to validity (and the built-in answers)

| Threat | Mitigation |
|---|---|
| **Spec circularity** — a spec extracted *from* good code smuggles its quality into the baseline's prompt | Information parity: use the real Linear tickets / business-level specs the pipeline itself consumed whenever available; extraction-from-code is fallback mode and is flagged in the report; specs reviewed to business-logic altitude (matches how the agency already writes tickets) |
| Judge favors its own generations | Direction of bias favors the *baseline* → measured uplift is a lower bound; add Claude to form a panel in v1 |
| Position bias | Mandatory A/B swap per comparison; disagreement = tie; bias sensitivity reported |
| Small-N statistics | Wilson / paired-Bayesian intervals; gate on CI lower bound; power-based sample sizing |
| Thin tests overstate correctness | Spec-derived augmented input generation (EvalPlus finding); differential testing both ways |
| Repo code assumed correct | Differential oracle — shared tests judge both sides |
| Baseline drift as models improve | Re-benchmark cadence (a periodic re-benchmarking methodology); security baseline empirically stable |
| Subscription rate limits mid-run | Resumable pipeline with per-module checkpointing; batch-size aware of the 5-h window |

---

## 6. Suggested MVP plan (for after you approve — no code yet)

**Phase 0 — demo (≈ $0, local):** TypeScript CLI, stages as §1; deterministic layer = Vitest/Jest runner + Semgrep + ESLint + gitleaks + jscpd + complexity distribution (+ Stryker mutation where cheap); Codex engine wrapper (stdin-closed, `--output-schema`, high reasoning, JSONL parsing); stats module (Wilson, paired bootstrap); outputs `score.json` + `report.html`. Demo it on a real client ERP repo with real Linear-ticket specs.

**Phase 1 — credibility hardening:** Claude judge panel + majority vote; calibration set (a few modules judged by humans, judge-vs-human agreement reported); GitHub Action (staging-branch friendly); trend tracking across runs.

**Phase 2 — platform play:** generalize the harness so any *skill* (not just codebases) can be benchmarked vs. zero-shot — the measurement backbone of the Skill Hub vision; per-client dashboards; SOC2-friendly evidence exports.

---

## 7. Key sources

**Verified in adversarial sweep:** EvalPlus (NeurIPS 2023) · SWE-rebench (arXiv 2505.20411) · TREAT multi-prompt eval (arXiv 2510.17163) · Bias-in-the-Loop LLM-judge audit (arXiv 2604.16790) · Pairwise code judging study (arXiv 2507.10535) · Position-bias study (OpenReview y3jJmrKWQ4) · Self-preference bias (arXiv 2410.21819) · SonarQube fault-prediction study (Empirical SE, Lomio et al.).
**Primary, verification incomplete (⚠):** Just et al. mutation testing (FSE 2014) · CodeScene Code Health validation (arXiv 2408.10754).
**Additional primary:** Anthropic "Adding Error Bars to Evals" (arXiv 2411.00640) · Bayes-evals small-sample intervals (arXiv 2503.01747) · Ties/leaderbot (arXiv 2412.18407) · LMSYS Bradley-Terry note · Veracode GenAI Code Security 2025 + Spring 2026 · GitClear AI Code Quality 2025 · "Asleep at the Keyboard" (CACM) · RACE benchmark (arXiv 2407.11470) · Maintainability-Index critique (van Deursen) · OpenAI Codex non-interactive docs.
