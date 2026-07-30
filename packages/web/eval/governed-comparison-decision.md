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

> **Status: pending the governed sweep.** The `-governed` data has not been
> collected yet, so `governedComparison` currently exports nothing and the
> per-guard deltas below are unfilled. This section is the committed contract
> the sweep fills in — do not delete it; replace the placeholders with the
> measured before/after cells and the keep/revert call.

### Read-back verification (#720)

- **Target — silent-failure** (`hetzner-invoice-silent-failure-models`):
  ungoverned _<pending>_ → governed _<pending>_ (Δ _<pending>_).
- **Controls** — happy-path, line-items: Δ _<pending>_ (regression? _<pending>_).
- **Verdict:** _<pending — keep | revert>_.

### Duplicate guard (#721)

- **Target — duplicate-guard** (`hetzner-invoice-duplicate-models`):
  ungoverned _<pending>_ → governed _<pending>_ (Δ _<pending>_).
- **Controls** — happy-path, line-items: Δ _<pending>_ (regression? _<pending>_).
- **Verdict:** _<pending — keep | revert>_.
