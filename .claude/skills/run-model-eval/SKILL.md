---
name: run-model-eval
description: Use when running the Eval-v1 agent-reliability benchmark (packages/web/eval) — benchmarking a newly released Ollama Cloud model, re-running or adding scenarios, refreshing the published dataset in packages/web/eval/data/, or when a long sweep needs unattended keep-alive (watchdog), stalls, or produced suspicious/contaminated results.
---

# Run Model Eval (Eval-v1, pinchy#669)

## Overview

State-based agent-reliability benchmark: real models over Ollama Cloud `/v1`
drive a Pinchy agent against mock email/ERP backends; grading reads the
database back, never the transcript. Harness mechanics live in
`packages/web/eval/README.md`; the published dataset contract in
`packages/web/eval/data/README.md`. This skill is the **operational runbook**:
the ordering, the iron rules, and the gotchas that are NOT recoverable from the
repo alone.

Core principle: **probe before you sweep, one sweep per stack, everything
resumes from JSONL.**

## Iron rules (each one cost us real damage once)

1. **PROBE FIRST.** Before any full sweep of a new model or scenario: run
   N=3 × 3-4 capable models (`EVAL_N=3`, `EVAL_CANDIDATE_MODELS=...`), then
   **read the trajectories** (`results/<label>.trajectories.jsonl`) — check
   tool calls, final messages, and that failures are model behavior, not
   harness artifacts. Probes caught: a false-green phrase-list grader, missing
   tool names in the audit collector, id-fidelity false-flags on multi-email
   inboxes, a mock that couldn't sum two-step line entries, a stack duplicate
   guard masking behavior. A full sweep on a broken grader wastes ~12h and
   contaminates the dataset.
2. **ONE SWEEP PER STACK.** Never run a sweep manually while the watchdog is
   armed (`active-scenario` ≠ `none`), and never two sweeps concurrently —
   they share mock state + the agent's model pin and **corrupt each other's
   state-based grades**. Check `pgrep -f eval:models` first. Contaminated
   models show ≠12 runs per cell: delete their rows from BOTH
   `<label>.jsonl` and `<label>.trajectories.jsonl`, then re-run them.
3. **odoo-mock is image-built** (`docker-compose.eval.yml` build context, no
   volume mount). Mock changes need
   `... up -d --build odoo-mock` — and never mid-sweep.
4. **Stack env is exact:** `PINCHY_VERSION=latest DB_PASSWORD=eval_dev_pw
   docker compose -p pinchy-eval -f docker-compose.yml -f docker-compose.e2e.yml
   -f docker-compose.eval.yml up --build -d`. `DB_PASSWORD` must be non-default
   (Pinchy rotates `pinchy_dev` away). If openclaw won't stabilise with
   `SecretRefResolutionError`: stale config volume — surgically delete
   `/openclaw-config/openclaw.json*` in the pinchy container and restart
   pinchy+openclaw (never `down -v`).
5. **Key is seeded once.** Pass `OLLAMA_CLOUD_API_KEY` via env on the first
   `eval:models` run (it lands in the eval DB); later runs and the watchdog
   resume **keyless**. Never write the key to disk.
6. **Fresh worktree: seed `results/` from `data/`** before topping up, or the
   rebuilt scorecards will contain only the new model:
   `cp packages/web/eval/data/*.jsonl packages/web/eval/data/*.json packages/web/eval/results/`
7. **Long sweeps run under the watchdog, not a session.** Session-spawned
   background sweeps die with the session. Install per the header of
   `watchdog.sh` (in this skill dir; launchd + `caffeinate`, checks every
   15 min, stall-kills after 30 min without progress). The Mac must stay
   awake and powered; keep `EXPECTED_RUNS` = models × N in sync.
8. **Publishing is manual and per-scenario:** copy
   `results/<label>{.jsonl,.trajectories.jsonl,.json}` → `eval/data/`, update
   the manifest table in `data/README.md`, commit as
   `data(eval): <scenario> ... (N models, M runs)`.

## Recipe: benchmark a new model

1. Add it to `TOOL_CAPABLE_OLLAMA_CLOUD_MODELS` (use the
   `update-ollama-cloud-models` skill; verify tools via
   `scripts/verify-ollama-cloud-tools.mjs --only=<id>`).
2. Stack up (rule 4) → `pnpm -C packages/web eval:selftest` green.
3. Seed `results/` (rule 6). **Probe** the new model, N=3, across the two
   cheapest discriminators (happy + silent); inspect trajectories (rule 1).
4. Add the id to `MODELS` + bump `EXPECTED_RUNS` in
   `~/.pinchy-eval-watchdog/watchdog.sh`, then per scenario label:
   `echo <label> > ~/.pinchy-eval-watchdog/active-scenario` and
   `launchctl kickstart gui/$(id -u)/com.pinchy.eval-watchdog`. Resume skips
   models already at N, so only the new model runs.
5. When each label completes: `pnpm -C packages/web tsx eval/regrade.ts
   <label> --quotes` (sanity + evidence quotes), then publish (rule 8).
6. Set `active-scenario` to `none` when done.

## Recipe: add a scenario

Pure data module in `eval/scenarios/` (reuse fixtures; extra inbox emails need
`extraGraphMessages` + `extraIssued*Handles` or id-fidelity false-flags) → new
grading mode only if needed (`ExpectedOutcome` + dispatch in `graders.ts`,
unit-test against real captured output, never invented phrasings) → wire into
`SWEEP_SCENARIOS` (eval-models.spec.ts) AND `SCENARIO_BY_LABEL` (regrade.ts) →
probe → full sweep → publish.

## Common mistakes

| Mistake | Consequence |
|---|---|
| Full sweep without probe | ~12h burned on a harness artifact; dataset pollution |
| Manual sweep while watchdog armed | Concurrent sweeps corrupt each other's grades |
| Judging a failure from `RunResult` tags alone | Tags lie when the harness is wrong — read the trajectory |
| Editing a grader without re-running `regrade.ts` on existing trajectories | Published numbers no longer match the grader |
| Grader phrases invented instead of calibrated | False-greens (the original silent grader passed blatant fabrications) |
| `down -v` to fix stack issues | Wipes the seeded key + eval DB |
| Trusting a failure-scenario score without the happy score next to it | Incapacity reads as diligence (mistral "honesty") |
