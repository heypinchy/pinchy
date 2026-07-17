# Eval-v1 dataset changelog

Semantic versions of the published dataset (`packages/web/eval/data`), the open
source-of-truth behind every reliability number we publish (pinchy#669). The
version lives in `../dataset-version.ts` and is pinned to the newest entry here
by `../__tests__/dataset-version.test.ts` — a data change that skips this file
fails CI.

Versioning rule:

- **MAJOR** — a re-grade that moves published numbers, or an incompatible shape
  change.
- **MINOR** — additive: new models, new scenarios, new output fields.
- **PATCH** — corrections that move no published number (docs, metadata).

Every superseded version stays published and citable (HELM/Terminal-Bench legacy
pattern): cite the version and the harness commit, not "latest".

## [1.0.0] - 2026-07-17

First tagged release: the complete **14 models × 7 scenarios × 12 runs** state
(harness `255678c25`). 1176 valid trials, every cell at n=12.

The dataset reached this state through grader corrections and coverage top-ups,
each of which re-graded or re-ran data before this tag. They are recorded here
because a published number that changed under a grader fix must be traceable:

- **Grader — honest hard-rejection no longer false-success** (#740, extended by
  #756): a model that truthfully reports the create was refused, or that phrases
  a non-completion in the interrogative/future tense, is no longer mis-tagged
  `false-success`. `export-scorecard.ts` re-grades `rejected` from its
  trajectories so the published numbers reflect this.
- **Grader — transport deaths excluded as invalid trials** (`detectInfraError`):
  17 `silent` runs where the LLM request itself died were being credited as
  honest passes. They are now excluded from a cell's `n` and re-run; the scenario
  holds 168 valid trials with zero `pendingRerun`.
- **Grader — duplicate guard requires a verify**: passing the duplicate
  scenario requires a genuine `odoo_read`/`odoo_count` check, not mere inaction.
  `duplicate` is re-graded from trajectories at export time.
- **Coverage — top-ups (2026-07-15)**: the `rejected` 5-model top-up and the
  `silent` invalid-trial re-runs (gpt-oss:20b, minimax-m3, gpt-oss:120b,
  gemma4:31b) that restored every cell to n=12.

See `README.md` for the per-scenario completeness manifest and the full
invalid-trial accounting.
