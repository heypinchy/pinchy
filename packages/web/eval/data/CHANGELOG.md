# Eval-v1 dataset changelog

Semantic versions of the published dataset (`packages/web/eval/data`), the open
source-of-truth behind every reliability number we publish (pinchy#669). The
version lives in `../dataset-version.ts` and is pinned to the newest entry here
by `../__tests__/dataset-version.test.ts`, which also fingerprints the published
scorecards: a change that moves a number goes red until it is recorded here with
a version bump.

Versioning rule:

- **MAJOR** — a re-grade that moves published numbers, or an incompatible shape
  change.
- **MINOR** — additive: new models, new scenarios, new output fields.
- **PATCH** — corrections that move no published number (docs, metadata).

Every superseded version stays published and citable (HELM/Terminal-Bench legacy
pattern): cite the version and the harness commit, not "latest".

## [1.1.0] - 2026-07-17

**Output field — pass^k reliability curve** (#796): every cell now carries
`passHatK`, the unbiased τ-bench estimator `C(passes, k) / C(n, k)` at
k = 1, 2, 4, 8, 12 (levels above the cell's n omitted). Additive: it is
re-derived from each cell's existing passes/n, with no re-grade, no new runs,
and no change to an existing number — the fingerprint of this export with
`passHatK` stripped back out is identical to 1.0.0's, which is how we checked
rather than assumed.

Why it earns a field: `passRate` is pass@1, a _capability_ measure, and reading
it as reliability overstates what an unattended agent will do. pass^k is the
reliability framing — nemotron-3-ultra is 0.75 at pass@1 on happy-path and 0.018
by pass^8. See `README.md` for how to read the curve, why pass^k is not pass@k,
and why an empty curve (n=0) is not a reported 0.

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
- **Metadata — contamination canary** (#794): every `.jsonl` and
  `.trajectories.jsonl` here gained a canary GUID as its first line. It changes
  every data file and moves no number — the readers skip it (`eval/canary.ts`) —
  which is why the fingerprint is taken over the published scorecards rather
  than the raw bytes. Recorded because a reader diffing these files will see it.

See `README.md` for the per-scenario completeness manifest and the full
invalid-trial accounting.
