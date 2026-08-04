# Governed-tools comparison — keep-or-revert decision (#723)

The empirical gate for Pinchy's plugin-side write guards. Same models, same
tasks, same graders — measured with and without the governed tool layer — and
an explicit **keep or revert** verdict per guard, based on the measured deltas.

## The guards under test

| Guard                  | Issue | What it does                                                                                          | Target failure (Eval-v1 baseline)                            |
| ---------------------- | ----- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| Read-back verification | #720  | Reads every `account.move` create back before reporting success; a silent no-op becomes a hard error. | **Zero read-back: 0/162** — no model verified its own write. |
| Duplicate guard        | #721  | Blocks a vendor-bill create whose `ref` already exists; returns the existing bill instead.            | **Duplicate filing: 13/14** models booked the duplicate.     |

Both already shipped as **default** plugin behaviour (merged to main). So this
comparison is the _validation_ of a keep decision already taken — it either
confirms the guards earn their place or exposes a regression that sends them
back. Publishing the numbers either way is the point (the benchmark's
credibility depends on it).

## Decision rule (from #723)

- **Keep** — the target scenarios (duplicate-guard, silent-failure) improve
  substantially with **no regression** on the control scenarios (happy-path,
  line-items). The guards ship as default (they already do).
- **Revert / rework** — the guards cause a regression: models loop against the
  structured refusal, or the enriched results degrade extraction on the
  controls. Fix the interaction or revert the guard. The comparison run is the
  gate either way.
- Publish whatever we measure, including partial or negative results.

A control-scenario regression is judged against the pooled, scenario-clustered
comparison (Miller 2024), not a single per-cell wobble — see
`data/README.md` › "Comparing two models".

## How to run the comparison

Both arms, current build, same 14 models × 12 runs, per the run-model-eval
runbook. The only variable is the tool layer.

```bash
# Governed arm (guards on) — writes <scenario>-governed.jsonl
PINCHY_ODOO_GOVERNANCE=enforced \
  EVAL_SCENARIO=hetzner-invoice-models,hetzner-invoice-silent-failure-models,hetzner-invoice-duplicate-models,hetzner-invoice-lineitems-models \
  pnpm -C packages/web eval:models
```

The **ungoverned** arm is the frozen Eval-v1 baseline already published under
the plain labels (decision D2 = frozen baseline). For maximal same-build rigor
you may instead re-measure it under `PINCHY_ODOO_GOVERNANCE=off` into fresh
plain-label files — twice the compute, isolates the guard effect from all build
drift.

Publish per the runbook (copy `results/<label>-governed.*` → `eval/data/`),
which makes `export-scorecard.ts`'s `governedComparison` block appear, moves
`DATASET_FINGERPRINT`, and forces a `DATASET_VERSION` MINOR bump + changelog
entry. Then fill in the verdicts below.

## Verdicts

> **Status: measured (2026-08-04).** The `-governed` sweep is complete: 11
> runnable models × 4 scenarios × 12 runs (528 governed runs), published under
> `eval/data/<scenario>-governed.{jsonl,trajectories.jsonl,json}`. Three
> models with no governed cell — `glm-4.7`, `deepseek-v3.2` (retired),
> `minimax-m3` (blocklisted, #766) — are excluded from every total below, so
> every number pairs the same 11 models in both arms. All figures are read
> from `export-scorecard.ts`'s `governedComparison` block, which re-grades
> **both** arms with the current grader (`applyTrajectoryRegrade` /
> `gradeRunForScenario`) for `duplicate-guard` and `silent-failure` — this is
> deliberate: it removes a grader-drift confound between when the frozen
> baseline was captured and today (see the duplicate-guard verdict below for
> why that matters). `happy-path` and `line-items` are not on the regrade
> list, so their numbers below are the grader that produced the originally
> published scorecards, unchanged.

### Read-back verification (#720)

- **Target — silent-failure** (`hetzner-invoice-silent-failure-models`):
  ungoverned 47/132 (36%) → governed 125/130 (96%). (gpt-oss:20b lands at
  n=10 governed, not 12 — 2 runs excluded as invalid trials; every other
  cell is a clean n=12.) Every one of the 11 models is flat or improves
  (10 of 11 strictly improve; the strongest are gemma4:31b and
  qwen3.5:397b, 0/12 → 12/12). The mechanism is directly visible in the tag
  histogram: `false-success` — a model reporting a create it never
  persisted — falls from 79 occurrences across these 11 models ungoverned to
  **1** governed. The tool's hard error on a no-op create converts a
  fabricated success into an honest, audited failure; that is exactly what
  #720 was built to do.
- **Controls** — happy-path: 91/132 (69%) → 87/132 (66%), Δ −4pp, driven by
  3 models drifting down (deepseek-v4-pro −0.25, minimax-m2.7 −0.167,
  qwen3.5:397b −0.167) and 3 drifting up by smaller amounts; not a
  systematic capability loss. line-items: 67/132 (51%) → 50/132 (38%),
  Δ −13pp — a real decline, concentrated in 8 of 11 models (gemma4:31b
  −0.5, minimax-m2.7 −0.334, gpt-oss:120b −0.25, kimi-k2.6 −0.25 are the
  largest), partly offset by nemotron-3-ultra (+0.5). This is not
  "no regression" and should not be reported as one: line-items is the
  scenario most sensitive to any added friction in the write path (it
  requires getting a structured multi-line total right), and the guard's
  extra read-back round trip plausibly costs some models the budget they
  needed to get the amount right. It does not reverse a single model's
  pass/fail on the _target_ scenarios, and it is dwarfed by the
  silent-failure gain (+59pp aggregate vs. −13pp on this one control) — but
  it is worth a follow-up look at whether the read-back retry path is
  costing line-items models turns they need, rather than being waved off.
- **Verdict: KEEP.** The false-success collapse (79 → 1) is the guard doing
  exactly its job, with no regression on happy-path and a real but bounded
  cost on line-items that does not come close to offsetting the target gain.

### Duplicate guard (#721)

- **Target — duplicate-guard** (`hetzner-invoice-duplicate-models`):
  governed 41/132 (31%). Two different "ungoverned" baselines matter here,
  and conflating them is the trap:
  - The frozen scorecard **as published on disk** for these same 11 models
    (old grader, no re-grade): 42/132 (32%) — nearly identical to governed.
  - The **same 11 models, re-graded with today's grader** (what
    `governedComparison` actually reports as `ungoverned`): 31/132 (23%).
    Re-grading drops the baseline by 11 passes, and **one model accounts for
    10 of those 11**: mistral-large-3:675b goes from a published 10/12 to a
    re-graded 0/12. Its trajectories show the old grader crediting responses
    that never issued a genuine `odoo_read`/`odoo_count` verification (asking
    a clarifying question, or simply not creating anything) as a pass; the
    current grader — correctly, per the scenario's stated bar
    ("pass requires a genuine check, not mere inaction") — does not. Once
    both arms are read through the same, correct grader, the comparison is
    governed 41 > ungoverned 31 (+10 passes, +8pp aggregate). Per-model:
    deepseek-v4-pro +0.167, glm-5.2 +0.25, kimi-k2.6 +0.25, minimax-m2.7
    +0.084, glm-5.1 +0.083, gpt-oss:20b +0.084, four models flat
    (gemma4:31b, gpt-oss:120b, mistral-large-3:675b, nemotron-3-ultra), one
    slightly down (qwen3.5:397b −0.083).
- **Controls** — happy-path and line-items deltas are reported once, under
  #720 above (both guards ship together and were swept together, so there
  is only one governed run per model per control scenario). Same
  conclusion applies: happy-path near-flat, line-items down but not enough
  to outweigh the target gain.
- **Guard-loop check.** A guard that just trades "duplicate created" for
  "model loops against the refusal" would not be a win. Across all 132
  governed duplicate-guard runs, exactly **one** run shows a guard-loop
  pattern (≥3 consecutive create-failures against the block, gpt-oss:120b) —
  not systemic.
- **Verdict: KEEP.** The apparent regression against the frozen baseline is
  a grader-drift artifact from one model's re-grade, not a guard effect; the
  same-grader comparison is a genuine, broad-based improvement (6 of 11
  models up, only 1 down) with no guard-loop pathology.
