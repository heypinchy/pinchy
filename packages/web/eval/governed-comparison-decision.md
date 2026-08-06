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

Prefer the same-build re-measure for line-items specifically: the frozen
line-items baseline was captured against a stack that did not enforce
many2one write validation on `account.move.line`, so 10 of its 67 passes are
false-greens (see the #720 controls verdict below). Bring the stack up with
`--build` when capturing a baseline — the eval `odoo-mock` is built from its
context, and a plain `docker compose up` will happily reuse an image older
than the fidelity fix it is supposed to be running.

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
- **Controls** — happy-path: 91/132 (69%) → 87/132 (66%), Δ −3pp (−4 passes), driven by
  3 models drifting down (deepseek-v4-pro −0.25, minimax-m2.7 −0.167,
  qwen3.5:397b −0.167) and 3 drifting up by smaller amounts; not a
  systematic capability loss. line-items: 67/132 (51%) → 50/132 (38%),
  Δ −13pp on the published numbers, spread over 8 of the 11 models (largest,
  in runs of 12: gemma4:31b −6, minimax-m2.7 −4, gpt-oss:120b −3, kimi-k2.6
  −3), 2 flat, 1 up (nemotron-3-ultra +6). That delta is **not attributable
  to the guards**: the two arms did not face the same write validation, and
  the mechanism proposed for a guard cost never fired once.

  _The frozen arm was credited for writes the current stack rejects._ The
  line-items baseline was captured 2026-07-13 (data commit `171862a94`,
  frozen into dataset v1.0.0 on 07-17); the governed arm is the 2026-08-04
  sweep. In the baseline, 21 `account.move.line` creates carry an
  `account_id` the plugin cannot resolve — 12 a display string ("Expenses",
  "Cloud Services"), 9 a raw numeric id — and **all 21 succeed**. In the
  governed arm the identical shapes are rejected, 22 out of 22 ("Raw numeric
  IDs are not accepted for account_id", "Could not resolve account_id from
  Expenses"). Real Odoo rejects them too, which makes the baseline's
  passes false-greens — and they are not a rounding error: **10 of
  gemma4:31b's 11 baseline passes** contain such a write, and gemma4:31b is
  the single largest published regression (−6). Across all 11 paired models,
  10 of the 67 baseline passes rest on it; drop them and the comparison
  reads 57/132 (43%) against governed 50/132 (38%).

  Two things this is _not_, both checked rather than assumed. It is not the
  guards: the rejection comes from the always-on ref normalizer, ungated by
  `PINCHY_ODOO_GOVERNANCE`, and it fires in the ungoverned arm too (7
  `partner_id` and 1 `journal_id` rejections on `account.move`). What
  differs is only where it lands — on `account.move.line`, 0 failures in 91
  baseline creates against 25 in 38 governed. And it is not simply
  "pre-#615": the mock's top-level many2one validation landed in
  `69e090871` on 2026-07-07, six days _before_ the baseline was captured, so
  the source already carried it. A stale eval image is the likeliest
  explanation — `docker-compose.eval.yml` builds `odoo-mock` from its
  context, and `docker compose up` without `--build` reuses an older image —
  but that is inference, not evidence, and until it is settled a baseline
  capture should pin `--build`. (Omitting `account_id` altogether is a
  different case and not a false-green driver: it succeeded 86/86 in the
  baseline and still succeeds today, 13 of 14.)

  _The same-build A/B agrees, within its power._ 2026-08-05, pinchy build
  `dd96d631e479`, `PINCHY_ODOO_GOVERNANCE` the only variable, three models
  at n=4 each: governed and ungoverned land **identically at 7/12 (58%)**,
  where the frozen baseline for those same three was 33/36 (92%) and their
  published governed cell was 22/36 (61%). The governed cell reproduces on
  the current build; the frozen one does not. Read that for exactly what it
  is — n=12 per arm is enough to show the baseline no longer reproduces and
  to put both arms on one point estimate, but nowhere near enough to _bound_
  a −13pp effect. It removes the attribution; it does not measure the guard
  cost to be zero. The trio is a diagnostic, not a dataset arm: gemma4:31b
  (−6) and kimi-k2.6 (−3) are among the largest capable regressions,
  deepseek-v4-pro (−2) is not, and minimax-m2.7 (−4) was not re-run. It is
  therefore deliberately unpublished and moves no fingerprint. Reproduce it
  by running the sweep command above twice, once per
  `PINCHY_ODOO_GOVERNANCE` value, with
  `EVAL_SCENARIO=hetzner-invoice-lineitems-models`, `EVAL_N=4`, and
  `EVAL_CANDIDATE_MODELS=ollama-cloud/gemma4:31b,ollama-cloud/kimi-k2.6,ollama-cloud/deepseek-v4-pro`.

  _The proposed mechanism never fired._ The earlier reading here was that
  the guard's extra read-back round trip "plausibly costs some models the
  budget they needed". Across all 136 `account.move` creates in the governed
  line-items arm, the read-back verification rejected **zero** — every one of
  the dataset's 257 read-back rejections sits in silent-failure, the scenario
  it was built for. A mechanism that never triggers cannot be the cost.
  `account.move` create-failure rates are close either way (governed 38/136 =
  28%, ungoverned 37/156 = 24%). Governed runs are also shorter (median 48s
  vs 81s, 8 vs 10 tool calls); read that as a symptom, not as evidence in
  either direction, since a shorter run is equally consistent with "less
  friction" and with "gives up sooner".

- **Verdict: KEEP.** The false-success collapse (79 → 1) is the guard doing
  exactly its job. happy-path is near-flat, and the one apparent control
  regression — line-items −13pp — is not attributable to the guards: the
  frozen arm was credited for writes the current stack (and real Odoo)
  rejects, the rejection that removes them is ungated by governance, the
  read-back verification rejected nothing at all in this scenario, and a
  same-build A/B puts governed and ungoverned at an identical 58%. What none
  of that does is _bound_ a small residual cost at n=12, so the honest claim
  is "not attributable", not "measured to be zero". Nothing established
  offsets the target gain.

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
  conclusion applies: happy-path near-flat; the line-items drop is not
  attributable to the guards (the frozen arm's unresolved-`account_id`
  false-greens plus a same-build A/B that puts governed = ungoverned — see
  #720 above).
- **Guard-loop check.** A guard that just trades "duplicate created" for
  "model loops against the refusal" would not be a win. Across all 132
  governed duplicate-guard runs, exactly **one** run shows a guard-loop
  pattern (≥3 consecutive create-failures against the block, gpt-oss:120b) —
  not systemic.
- **Verdict: KEEP.** The apparent regression against the frozen baseline is
  a grader-drift artifact from one model's re-grade, not a guard effect; the
  same-grader comparison is a genuine, broad-based improvement (6 of 11
  models up, only 1 down) with no guard-loop pathology.
