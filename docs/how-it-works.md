# How 2bench works — the whole thing, in plain language

*Read this top to bottom and you'll understand the entire project — what it's for, how it thinks, and why every piece is the way it is. No prior knowledge assumed. If a word looks technical, it's defined the first time it shows up, and there's a glossary at the very end as a safety net.*

---

## 1. The problem this exists to solve

Imagine you run a company that builds **custom AI tools** for clients. Building custom things is expensive — it takes smart people, time, and money.

But here's the uncomfortable question that never goes away:

> **Was the custom work actually worth it? Or could we have gotten basically the same result by just asking a plain, off-the-shelf AI to do it?**

Off-the-shelf AI is cheap and getting scarily good. So if your fancy custom pipeline only produces work that's *a tiny bit* better than what a free, plain AI would spit out… you're burning money for almost nothing.

Most companies answer this question with **vibes** — "it feels better," "the client seems happy." Vibes don't survive a tough meeting with a client's finance team.

**2bench replaces the vibes with a number.** A number you can defend.

---

## 2. The big idea: a fair bake-off

The easiest way to understand 2bench is to picture a **blind bake-off** (like a TV cooking competition).

- **Contestant A: your work.** The thing your team actually built — a piece of software, or a set of custom "house rules" for an AI.
- **Contestant B: the box mix.** A plain, vanilla AI given the *same recipe card* and told "you build it too, from scratch, with no help." This is called the **zero-shot baseline** — "zero-shot" just means "no examples, no coaching, no special instructions; one clean try."
- **The recipe card: the spec.** A short description of *what the thing is supposed to do* — its job, not how to do it. **Both contestants get the exact same recipe card and nothing else.** This fairness rule has a name: **information parity**. Whoever gets more information would have an unfair edge, so we make sure they get *identical* information.
- **The judges: a mix of automated tests, code scanners, and (only when needed) an AI acting as a referee.** They score both dishes on the same criteria, blind.

Then 2bench measures the gap:

> **"Uplift" = how much better your dish scored than the box mix.**

If your custom cake beats the box mix by a mile, the custom work earned its keep. If it barely wins — or *loses* — you just learned something expensive but important, and you learned it *before* the client did.

That's the entire soul of the project. Everything else is making that bake-off **fair, repeatable, and honest.**

---

## 3. The 40% rule (the bar)

A bake-off needs a passing line. 2bench's default line comes from **a common agency rule**:

> Custom AI work must beat plain zero-shot prompting by **at least 40%** to justify existing.

Why have a bar at all? Because "a little better" isn't good enough to justify the cost and risk of custom work. 40% is the line the agency drew in the sand: clear the bar, and the custom work is worth it; don't, and you should rethink it.

You can change this number in the config, but whatever it is, it's always shown in the report — no hiding the bar to make yourself look good.

---

## 4. The two things you can put in the bake-off

2bench can grade two different kinds of "contestant," using the **exact same machinery**:

### a) A whole codebase — the `score` command
"How much better is this software than what a plain AI would have built from the same specs?"

Your real code goes head-to-head against a plain AI's rebuild of the same features.

### b) A skill — the `skill` command
A **skill** is a reusable set of instructions you give an AI — house rules, a template, a special prompt. (Think: "always calculate Canadian tax like *this*.")

"Does this skill actually make the AI better, or is it decoration?"

Here the bake-off is even cleaner: you run the **same tasks twice through the same AI** — once *with* the skill switched on (the **treatment** group), once *with it off* (the **control** group). The skill is the *only* difference between the two runs, so any difference in quality is caused by the skill and nothing else. (This is exactly how a medical drug trial works: same patients, one gets the pill, one gets a sugar pill, compare.)

Both modes produce the **same kind of report and the same uplift %**, so you learn to read one and you can read them all.

---

## 5. How the bake-off actually runs, step by step

Here's what happens when you score a codebase. Each step has a plain-English "why."

**Step 1 — Inventory.** 2bench walks through the codebase and breaks it into **modules** (a module is just "a folder of code with one job"). It notes how big each one is and what kind it is.
*Why:* You can't grade a whole codebase as one giant blob. You grade it in sensible pieces.

**Step 2 — Sample.** It doesn't test *every* module (that'd be slow and expensive). It picks a **representative sample** — a fair spread across the different parts of the codebase. Crucially, this pick is **seeded**: it uses a fixed starting number so the "random" choice is *the same every time you run it*. Reproducible randomness.
*Why:* Fairness and repeatability. If two people run it, they must sample the same modules and get the same answer. No cherry-picking.

**Step 3 — Get the recipe card (spec).** For each sampled module, 2bench needs a plain description of what it's supposed to do. There are two ways to get it:
- **The good way:** feed it the *real* tickets your team wrote (e.g. from Linear, a task-tracking tool). These are the true, independently-written recipe cards. You pass these with `--specs`.
- **The fallback way:** if you don't have tickets, 2bench reads your code and *guesses* the recipe. This works, but it's flagged as less trustworthy — see **"What if you don't have real tickets?"** just below, and section 7 for the deeper trap.

**Step 4 — Bake the box mix (regenerate the baseline).** 2bench hands the recipe card to a plain AI (via **Codex**, the AI engine it uses) and says: "Build this from scratch. You get the spec and nothing else — no peeking at the real code." It does this **several times** with slightly reworded prompts, because asking an AI once is unreliable — like a student who aces a test one day and bombs it the next. Multiple tries give a stable picture of what the plain AI *typically* produces.
*Why:* One sample from an AI is noise. Many samples reveal the real average — and also reveal how *consistent* the plain AI is, which becomes a score of its own (see "consistency" below).

**Step 5 — Judge both dishes on the same criteria.** Now both your code and the AI's rebuild get scored on four things (next section). Wherever possible, the judging is done by **real, automated tools** — actual tests that run, real scanners that check for security holes. Only for the fuzzy, taste-based stuff (like "is this code well-organized?") does an **AI referee** step in.

**Step 6 — Do the math and produce the verdict.** Combine all the scores into one **uplift %**, wrap it in an honesty check (section 8), compare it to the 40% bar, and write two things: a machine-readable result (for automation) and a nice human-readable report (for people and clients).

That's the pipeline: **inventory → sample → spec → rebuild → judge → math → report.**

### What if you don't have real tickets?

**Short version: 2bench still runs — it just switches to "guess mode" for the recipe card, and it's upfront about the downgrade.**

When you *don't* hand it real tickets, 2bench reads each module's code and writes the spec *from* it. It's deliberately told to describe only *what the module does* — the business rules, the inputs and outputs — and to ignore the actual code (no function names, no libraries, no structure). The goal is a recipe card at the "what," not the "how," altitude. A spec made this way is tagged **extracted** (real tickets are tagged **linear**), and the report labels the whole run as extracted so nobody mistakes it for the gold-standard mode.

The catch is the **recipe-card trap** from section 7: a spec traced from your own code can quietly leave out things your code *does* but the words don't capture — and then the rebuilt "box mix" is judged against that same incomplete card, which can make *your* (better) code look worse. So guess-mode is genuinely **less trustworthy** than real tickets.

Because of that, whenever it has to guess, 2bench adds three safety nets:

1. **A leakage check.** It measures how much of the "spec" is just vocabulary lifted straight out of your code's names. High overlap means the spec is peeking at the implementation — and that gets flagged.
2. **A suite-fidelity guard.** If your real code suddenly scores *far below* the AI's rebuild on the tests — the tell-tale sign of an unfair, incomplete spec — 2bench stops trusting that correctness number, hands that module to the human-judgment path instead, and warns you in the report.
3. **Honest labeling everywhere.** The run, the saved history entry, and the report all say "extracted spec," so the caveat travels with the number.

**Bottom line:** guess-mode is fine for a quick self-check or a rough read. But for a number you'll actually put in front of a client, feed it the **real tickets** (`--specs <folder>`) — that's the honest, apples-to-apples mode where the recipe card is genuinely independent of both sides. If your team uses **Linear**, `2bench linear` pulls those tickets and writes the `--specs` files for you, so getting to the trustworthy mode is one command.

*(Good to know: the **skill** mode never has this problem. There, the task prompts you write **are** the spec — independent by construction — so there's nothing to guess.)*

---

## 6. What it grades: the four scores

Every contestant is scored on four **dimensions**. Here's each in plain terms, and how much it counts by default (the weights are adjustable and always disclosed):

| Dimension | The plain-English question | Weight | How it's measured |
|---|---|---|---|
| **Correctness** | Does the code actually *work* — does it do what the spec asked? | 40% | **Real tests that actually run.** 2bench writes a test suite from the spec and runs it against *both* sides. This is the heaviest score because "does it work" matters most. |
| **Security** | Are there dangerous mistakes — holes an attacker could use, or passwords left lying around in the code? | 25% | Real security scanners (when installed). |
| **Maintainability** | Is the code clean and easy for a human to work with later, or a tangled mess? | 20% | Scanners for over-complex code, copy-paste duplication, and style problems. |
| **Consistency** | Does it produce *reliable* results, or is it all over the place from one run to the next? | 15% | How much the AI's multiple rebuilds *varied* from each other. Lots of variation = low consistency. |

The single most important design choice here: **correctness is decided by tests that literally execute the code**, not by an AI's opinion. An AI *guessing* whether code works is unreliable; a test that runs and passes (or fails) is a fact. 2bench leans on facts wherever it possibly can, and only uses AI judgment for the genuinely subjective stuff.

### Under the hood: how each score is measured

Here's what's actually happening behind each of the four, still in plain terms.

**Correctness — tests written from the spec, run for real.**
2bench turns the recipe card into an actual **test suite** — a batch of little checks like "given input X, the answer must be Y," "an empty list returns 0," "a bad input must raise an error." Those tests come from the *spec*, not from your code, so they're neutral. It then runs the **same** suite against both your code and the AI's rebuild, and the score is simply the **fraction of tests that pass**. The suite is deliberately padded with tricky edge cases, because a thin set of tests makes *everything* look correct. And because both sides face the identical suite, when they disagree the **test** decides — your code isn't assumed right just for being the real one. *(There's an optional, tougher check on the roadmap — "mutation testing" — that grades the tests themselves by deliberately breaking the code to see whether a test notices.)*

**Security — automated scanners for known-dangerous patterns and leaked secrets.**
Two tools comb both versions. One (**Semgrep**) looks for known dangerous patterns — the mistakes attackers exploit, like a page that doesn't sanitize user input. Each finding is weighted by how serious its category is, and the score is essentially "how few serious problems per line." The other (**gitleaks**) hunts for **secrets left in the code** — passwords, API keys, tokens — and *any* of those is surfaced as its own loud red flag, not quietly averaged away. If a scanner isn't installed, this score is honestly marked **"not measured"** rather than faked to zero (the "degrade loudly" rule) — which is exactly why security showed as missing in your `/doctor` run on Windows.

**Maintainability — three cheap, objective health checks, averaged.**
Up to three sub-checks, whichever are available: **complexity** (how tangled the code is — and it looks at the *share of code sitting in overly-complex files*, not the average, because averages hide the few monster files that actually hurt); **duplication** (how much is copy-pasted); and **style/lint** (how many style-rule violations per line). All three are objective and reproducible — run them twice, get the same answer.

**Consistency — does it give the same result twice?**
This one's a little different from the others. Your **delivered** code is a fixed thing — it doesn't change between runs, so it's perfectly consistent. The one really on trial here is the **plain AI**: remember it rebuilt the module several times back in Step 4. 2bench measures how much those rebuilds **varied** — both how similar the code is across the tries, and whether they *behave* the same (do they pass the same tests?). Lots of variation = low consistency. This captures something genuinely valuable about shipped software: it's the same every time, whereas re-prompting a plain AI is a roll of the dice.

### The scanners, by name

Most of those scores come from small, well-known tools doing one job each. Here's what every one actually is — and `2bench doctor` tells you which are installed on your machine:

| Tool | What it is | What it checks | Feeds |
|---|---|---|---|
| **Complexity** (built-in) | 2bench's own analyzer, using the TypeScript compiler — always available | how tangled each file is, reported as the *share of code NOT sitting in over-complex files* | maintainability |
| **jscpd** | the "JavaScript Copy/Paste Detector" | how much code is duplicated (copy-paste) | maintainability |
| **ESLint** | the standard JavaScript/TypeScript linter | style and code-quality rule violations, per line | maintainability |
| **Semgrep** | a pattern-based security scanner using OWASP/CWE rules | dangerous code patterns — injection, cross-site scripting, unsafe `eval`, etc. — each weighted by how serious its class is | security |
| **gitleaks** | a secret scanner | hardcoded passwords, API keys, and tokens left in the code (any hit is flagged loudly) | security |
| **the test harness** (built-in) | 2bench writes a test suite from the spec and runs it against both sides | whether the code actually *works* | correctness |
| **Stryker** (on the roadmap) | a mutation tester | how good the *tests themselves* are — it breaks the code on purpose and checks whether a test notices | correctness (test quality) |

Two things worth repeating from earlier: the **built-in** tools (complexity, the test harness) always run; the **external** ones are optional, and a missing one is marked **"not measured"**, never faked to zero (that's *degrade loudly*). Only Semgrep needs a network connection while it runs — it downloads its rule set from the registry.

---

## 7. The honesty problem (and how 2bench stays honest)

This is the most important section, because a benchmark that lies to you — even by accident — is worse than no benchmark. 2bench is built around a bunch of "don't fool yourself" rules. Here they are, translated.

**The judge's position bias — fixed by swapping.** If you show a referee two things and ask "which is better?", referees have a subtle habit of favoring whichever one they saw *first* (or second). So 2bench asks **every** comparison **twice** — once in each order (A-vs-B *and* B-vs-A). If the "winner" flips just because the order flipped, that's revealed as bias, not a real win. This cancels the thumb-on-the-scale.

**Ties count as a half.** If two dishes are genuinely equal, that's not a win for either. A tie counts as half a point to each side — never rounded up into a fake victory.

**Only brag about the worst case.** When 2bench measures uplift, it doesn't get one perfect number — it gets a *range* it's confident about, like "the real uplift is somewhere between +22% and +48%." (That range is called a **confidence interval** — see section 8.) The gate does **not** use the middle or the rosy top of that range. **It uses the bottom.** You only pass the 40% bar if even the *pessimistic* end of the range clears 40%. This makes the tool hard to fool and its "pass" genuinely meaningful.

**If you can't measure it, say so — never fake it.** Some scanners are optional and might not be installed (you saw this with `/doctor`: semgrep, gitleaks, etc. showing "missing"). When a score can't be measured, 2bench marks it **"not measured"** and warns you — it does **not** quietly record it as a zero. A fake zero would drag your score down for no reason and lie about what was actually checked. This rule is called **"degrade loudly."**

**The recipe-card trap (spec circularity).** This one's subtle but important. Remember the "fallback" recipe card from Step 3 — the one 2bench *guesses* by reading your code? Here's the danger:

> Imagine the recipe card was made by having someone glance at your finished cake and scribble down what they saw. They'll miss things — the secret filling, say. Now here's the trap: both the box-mix cook **and the judges** only know about what's on that incomplete card. So the box mix perfectly matches the incomplete card, and *your* cake gets marked down for having a filling that nobody wrote on the card. That's backwards — your cake was *better*, but the unfair recipe card made it look worse.

That's exactly what can happen when the spec is guessed from your code instead of written independently. The honest fix: **use real tickets** (`--specs`), which are true, complete recipe cards both sides genuinely owed. And when 2bench *has* to guess, it **watches for this trap** — if your real code suddenly scores far below the rebuild on the tests, it flags that correctness number as "possibly unfair" instead of trusting it. (2bench discovered this by scoring *itself* and catching its own unfair result — and rather than quietly fudge the number to look good, it built the warning. That's the culture of the tool.)

Add all this up and you get a benchmark that is **allergic to fooling itself.** That's the reason its "yes" is worth trusting — because it's so willing to say "no."

---

## 8. The statistics, gently

You don't need to love math for this — you need one idea.

**Small samples are liars if you take them at face value.** If you flip a coin 4 times and get 3 heads, you can't conclude "this coin is 75% heads." Four flips is too few to be sure. Same with grading a handful of code modules.

So instead of reporting a single confident-sounding number, 2bench reports a **range it's actually confident in**, called a **confidence interval**. "95% confidence interval of +22% to +48%" means: *"We're 95% sure the true uplift is somewhere in that band."* A wide band means "we're not very sure yet — test more"; a narrow band means "we've nailed it down."

Two more honest touches:
- It builds these ranges using a technique (called **bootstrapping**) that **doesn't assume the results follow a neat bell curve** — because with tiny samples, assuming a bell curve is another way to fool yourself.
- It's careful about **grouping**. If you sample five modules but they all come from the same corner of the codebase, that's really more like *one* opinion repeated five times, not five independent opinions. 2bench accounts for this so it doesn't sound more confident than it should.

The payoff: when 2bench says "this passes," it's not a lucky coin flip — it's a claim that survives a genuinely skeptical statistical check.

---

## 9. Why the score is a moving target

Here's a twist that trips people up: **your uplift score can drop even when your work didn't get worse.**

Why? Because the "box mix" — the plain AI you're being compared against — **keeps getting better every few months.** The bar you're jumping over is quietly rising on its own.

So:
- If your uplift **stays the same** while plain AI got smarter, that secretly means **your pipeline got better too** (you kept your lead against a faster runner).
- If your uplift **drops** right after a new AI model comes out, that's likely **the plain AI catching up**, not your team slipping.

2bench tracks this for you. Every run is saved to a history, and it **records which AI model it was measured against.** So when a number moves, the report can tell you *"this shifted because the baseline AI changed"* rather than letting you panic that your work regressed. The `/history` command and the dashboard show this trend over time.

---

## 10. The two ways to use it

There are two front doors, and they do the exact same things underneath.

### Door 1: Just talk to it (the friendly agent)
Run `2bench` with no extra words and you get a chat window — a banner, the list of commands, and a prompt. You can either:
- **Type a command** starting with `/` (like `/doctor`) to run it right now, or
- **Ask a plain-English question** (like "how good is my repo?") and it answers, then *offers* to run the right command for you. You confirm before anything expensive happens — the agent can *suggest*, but it never fires off a costly run on its own.

This is the newcomer-friendly door. When you're not sure what to do, ask it.

### Door 2: Type commands directly (for scripts and automation)
The same commands work as plain shell commands, which is what you'd wire into an automated pipeline. Here's the whole menu:

| Command | What it does |
|---|---|
| `doctor` | *"Is everything plugged in?"* Checks the AI engine and the scanners are installed and ready. |
| `inventory <repo>` | *"Show me the pieces."* Lists the codebase's modules and marks which ones would be tested. Free, instant, no AI. |
| `score <repo>` | **The main event.** Runs the full bake-off on a codebase and produces the uplift %. |
| `skill <file>` | Runs the bake-off on a *skill* instead of a codebase. |
| `history` | Shows how the uplift score has moved across past runs. |
| `serve` | Opens the portfolio dashboard (a webpage) on your own computer, showing all your past scores. |

The natural order the first time: **`doctor` → `inventory .` → `score .` → `serve`.** (Ready? → peek at what'll be tested → the real grade → see it on a dashboard.) The `.` just means "the folder I'm currently in."

---

## 11. Where it runs, and why that matters

Everything runs **on your own machine.** The code you're grading never gets uploaded anywhere. That's a deliberate, important choice for two reasons:

1. **Privacy.** The code you evaluate often belongs to clients. It must not leave your laptop. Even the dashboard webpage is served **only to your own computer** ("loopback only") — it's not exposed to the office network or the internet unless you make a deliberate decision to do so.
2. **Cost.** The AI engine (Codex) runs on a flat monthly subscription, so running a demo costs essentially **nothing extra**. There's no per-use meter ticking. That's why you can run it freely and often.

---

## 12. The whole thing on one page

```
The question:  "Is our custom AI work actually better than a plain AI —
                by enough to be worth it (the agency's bar: 40% better)?"

How it answers, for a CODEBASE:

   your codebase                        a plain zero-shot AI
        │                                        │
        │        both get the SAME spec          │
        │      (real tickets > guessed spec)     │
        ▼                                        ▼
   ┌─────────────────────────────────────────────────┐
   │  graded on the SAME four things, blindly:        │
   │  • Correctness  (real tests that actually run)   │
   │  • Security     (real scanners)                  │
   │  • Maintainability (real scanners)               │
   │  • Consistency  (how much the AI's tries varied) │
   └─────────────────────────────────────────────────┘
        │                                        │
        └──────────────► the GAP ◄───────────────┘
                            │
                    "uplift %" + a confidence range
                            │
              Pass only if even the PESSIMISTIC end
                     of the range clears 40%
                            │
              score.json (for automation) + report.html (for humans)

For a SKILL: same picture, but the two sides are
"same AI WITH the skill" vs "same AI WITHOUT it."
```

If you remember only one sentence: **2bench is a fair, repeatable, deliberately-skeptical bake-off that turns "was our custom AI worth it?" into a number you can defend — and it's honest enough to tell you "no."**

---

## 13. Glossary (every term in one line)

- **Zero-shot / baseline:** a plain AI's single clean attempt with no coaching or examples — the "box mix" you're being compared against.
- **Uplift:** how much better your work scored than that baseline. The headline number.
- **Spec:** the plain description of what a piece of software is *supposed* to do — the shared "recipe card."
- **Module:** a folder of code with one job; the unit 2bench grades.
- **Sample:** the representative subset of modules actually tested (picked reproducibly, not cherry-picked).
- **Codex:** the AI engine 2bench drives to rebuild baselines and act as a referee.
- **Dimension:** one of the four things graded — correctness, security, maintainability, consistency.
- **Deterministic scoring:** scoring done by real tools/tests that give the same answer every time (facts, not opinions).
- **Judge / referee:** an AI used *only* for the subjective scores that no tool can measure.
- **Position swap:** asking each comparison in both orders to cancel the referee's "I like whichever I saw first" bias.
- **Confidence interval:** the range the tool is genuinely confident the true answer lies in (e.g. "+22% to +48%").
- **Gate / the bar:** the pass/fail line (default 40%); you pass only if the *bottom* of your confidence range clears it.
- **Degrade loudly:** if something can't be measured, mark it "not measured" and warn — never fake a zero.
- **Information parity:** both sides get *identical* information, so neither has an unfair edge.
- **Spec circularity:** the trap where a spec guessed from your code quietly rigs the test against your code; avoided by using real tickets, and flagged when unavoidable.
- **Extracted vs. real (Linear) spec:** an *extracted* spec is guessed from your code (the fallback, flagged as less trustworthy); a *real / Linear* spec comes from independently-written tickets (the honest, apples-to-apples mode passed with `--specs`).
- **Seeded / reproducible:** "random" choices use a fixed starting number so runs are repeatable and can't be cherry-picked.
- **Skill:** a reusable set of AI instructions (house rules / a template) that you can also put in the bake-off.
- **Treatment vs control:** in a skill test, the run *with* the skill vs the run *without* it — the skill is the only difference.
- **Loopback only:** the dashboard is served only to your own computer, never the network.
- **The moving target:** the baseline AI keeps improving, so holding your uplift steady secretly means your pipeline improved too.

---

*Want the technical version? `docs/architecture.md` has the engineering detail and the nine formal invariants; `docs/research-report.md` has the evidence behind every design choice. This file is the map; those are the terrain.*
