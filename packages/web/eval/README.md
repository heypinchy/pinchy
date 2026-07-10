# Eval-v1 — model-reliability eval harness (pinchy#669)

Eval-v1 answers one question with evidence instead of vibes: _when a real
candidate model drives Pinchy's tool loop end-to-end, how often does it
actually finish the job correctly?_ It exists because the model-selection
methodology (`packages/web/eval/model-selection-methodology.md`) sits at the
top of an evidence hierarchy that starts with "our own production telemetry +
in-house eval scorecard" — this harness is what produces that scorecard.

## The scenario

The harness ships one scenario today: **Hetzner invoice**
(`packages/web/eval/scenarios/hetzner-invoice.ts`). A Microsoft-365 email
agent must, in one turn: list the inbox, read the Hetzner invoice email,
download its PDF attachment, and create a vendor bill in Odoo
(`account.move`, `move_type: "in_invoice"`). It's a deliberately small,
concrete stand-in for the class of write-loop failures the methodology's R1
rule is about (id corruption, false-success narration, loop non-completion).

Grading is **state-based**, not text-based: the harness re-reads the Odoo
mock's `account.move` records and the audit trail after the run and checks
what actually happened, not what the model claimed happened. See
`packages/web/src/lib/eval/graders.ts` for the seven pure graders (task
completion, audit honesty, id fidelity, false-success claims, loop
detection, thinking-leak detection, refusal detection) and
`packages/web/src/lib/eval/scorecard.ts` for how N graded runs become a
per-model pass-rate with a Wilson 95% interval.

## Grading criteria (v1) — identity is hard-gated, the amount is a soft signal

The first real sweep exposed a grading-design question, and the answer follows
established agentic-eval practice (τ-bench / τ²-bench, WorkBench; Anthropic and
Amazon τ²-bench-Verified guidance):

- **Grade the final environment state, never the transcript claim.** The
  harness re-reads the Odoo mock and the audit trail; a model that _says_ "done"
  without a matching `account.move` fails (`false-success`).
- **Hard-gate the fields the agent directly controls and the task specifies
  unambiguously**: vendor (`partner_id`), invoice number (`ref`), and date. The
  date is normalized across Odoo's `invoice_date` and `date` columns — models
  legitimately use either, and the task means "the right date," so field-name
  choice is not scored as an error (the τ-bench "one unambiguous outcome"
  principle).
- **Treat the invoice amount as a soft signal, not a pass gate.**
  `amount_total` is a _derived_ field in Odoo (computed from `line_ids`, never
  set directly). Requiring it demands full line-item entry with a seeded chart
  of accounts — scaffolding a v1 minimal scenario doesn't provide — and a mock
  that doesn't compute a field the grader asserts is a "Database Accuracy"
  defect, not a legitimate model failure. A missing/wrong amount is recorded as
  `amount-not-captured` in the taxonomy but does **not** fail the run.
- **A uniform 0% pass across all candidate models is a signal to fix the eval,
  not to rank the models.** The first sweep's uniform "amount missing" failure
  was exactly that — a grader/mock-fidelity artifact — which is why the amount
  became a soft signal here.

**v2 direction** (the gold-standard pattern): seed a chart of accounts, sharpen
the prompt to require line items, have the odoo mock _compute_ `amount_total`
from `line_ids`, and assert the full resulting state against a gold-action
replay — then the amount can be hard-gated fairly and will discriminate on
line-item-entry capability.

## Architecture

```
scenarios/hetzner-invoice.ts   pure scenario data (seed fixtures, expected invoice)
src/lib/eval/normalize.ts      pure: raw audit rows + artifacts -> RunTrajectory
src/lib/eval/graders.ts        pure: RunTrajectory -> GraderResult / RunResult
src/lib/eval/scorecard.ts      pure: RunResult[] -> per-model ScorecardEntry[]
eval/run-eval.ts               orchestration: dispatch, scrape, seed, grade, write
eval/eval-shared.ts            agent setup shared by both spec files below
eval/eval-selftest.spec.ts     selftest mode entry point (asserts pass/fail)
eval/eval-models.spec.ts       models mode entry point (no assertions, writes scorecard)
eval/playwright.eval.config.ts Playwright config; EVAL_MODE selects which spec runs
docker-compose.eval.yml        port-isolated stack overlay (Pinchy + OpenClaw +
                                odoo-mock + graph-mock, production images)
```

The pure/orchestrator split matters: `normalize.ts`, `graders.ts`, and
`scorecard.ts` have zero I/O and are unit-tested with hand-built fixtures
(`src/lib/eval/__tests__/`). Everything that talks to a running stack —
dispatching chat messages, scraping the DOM, seeding mocks, querying the
audit API — lives in `run-eval.ts` / the two spec files and is exercised by
actually running the stack, not by a fast unit suite.

Mode selection happens at the Playwright-config level (`testMatch` picks
`eval-selftest.spec.ts` or `eval-models.spec.ts` based on `EVAL_MODE`), not
via a runtime `test.skip(condition)` inside one shared spec — the latter
would mean both modes' tests are always _collected_, which the repo's
no-untracked-skips drift guard (only `.skipIf(` is a recognized conditional
gate) flags as an untracked skip.

## Running the self-test (no API key needed)

The self-test proves the whole pipeline is wired correctly using the
in-repo fake-ollama server (see `packages/web/e2e/shared/fake-ollama/
fake-ollama-server.ts`, triggers `FAKE_OLLAMA_HETZNER_HAPPY_TRIGGER` /
`FAKE_OLLAMA_HETZNER_FALSE_SUCCESS_TRIGGER`): a scripted "happy" 4-tool
sequence must grade `passed: true`, and a scripted "false-success" sequence
(claims completion after only 2 tool calls, never calls `odoo_create`) must
grade `passed: false` with the `false-success` tag. Unlike the `models`
mode, the self-test makes real assertions — it's deterministic, so a
regression here is a real bug in the harness or the graders.

```bash
# Bring up the port-isolated eval stack (production images, like the
# integration suite). DB_PASSWORD must be a NON-default value: the production
# image rotates the insecure `pinchy_dev` default away on boot (secret-source
# #156), after which the host-side Playwright helpers can no longer
# authenticate. ENCRYPTION_KEY + BETTER_AUTH_SECRET are baked into
# docker-compose.eval.yml as fixed test values (throwaway stack, mock data),
# and the eval:selftest script passes the same ENCRYPTION_KEY so the
# host-encrypted mock Microsoft credentials decrypt inside the container.
PINCHY_VERSION=latest DB_PASSWORD=eval_dev_pw docker compose -p pinchy-eval \
  -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.eval.yml \
  up --build -d

DB_PASSWORD=eval_dev_pw pnpm -C packages/web eval:selftest
```

## Running the real model sweep

Requires `OLLAMA_CLOUD_API_KEY`. Dispatches the same scenario against each
candidate model over Ollama Cloud `/v1:cloud`, `EVAL_N` times each (default
5), and writes a scorecard — **no per-run assertions**. This mode measures
model behavior; it does not gate CI on it.

```bash
PINCHY_VERSION=latest DB_PASSWORD=eval_dev_pw OLLAMA_CLOUD_API_KEY=... \
  docker compose -p pinchy-eval \
  -f docker-compose.yml -f docker-compose.e2e.yml -f docker-compose.eval.yml \
  up --build -d

DB_PASSWORD=eval_dev_pw OLLAMA_CLOUD_API_KEY=... pnpm -C packages/web eval:models
```

Override the candidate set or run count with env vars:

```bash
EVAL_CANDIDATE_MODELS="ollama-cloud/kimi-k2.6,ollama-cloud/glm-4.7" \
EVAL_N=10 \
OLLAMA_CLOUD_API_KEY=... pnpm -C packages/web eval:models
```

## Reading a scorecard

`models` mode writes `packages/web/eval/results/hetzner-invoice-models.json`:

```json
{
  "generatedAt": "2026-07-07T12:00:00.000Z",
  "runs": [/* one RunResult per dispatched run */],
  "scorecard": [
    {
      "model": "ollama-cloud/kimi-k2.6",
      "n": 5,
      "passes": 4,
      "passRate": 0.8,
      "wilson95": [0.375, 0.964],
      "tagHistogram": { "false-success": 1 },
      "medianLatencyMs": 8421,
      "medianTokens": 1203
    }
  ]
}
```

`scorecard` is sorted by `passRate` descending. `wilson95` is a 95%
confidence interval on the true pass rate given `n` trials — with small `n`
(5–10) the interval is wide; don't over-read a single-point pass-rate
difference between two models without checking whether the intervals
overlap. `tagHistogram` counts which `FailureTag`s fired across all failing
runs for that model — this is usually more actionable than the raw pass
rate (e.g. "always `id-malformed`" points at a very different fix than
"always `task-incomplete`").

## Current candidate set and why

The default candidates in `eval-models.spec.ts` are `kimi-k2.6`, `gemma4:31b`, and
`glm-4.7` — the three models named in the model-selection methodology's R1
evidence (the 2026-07-07 staging incident: `gemma4:31b` corrupted a Graph
message id across turns while the audit trail showed green; `glm-4.7` loops
when `reasoning_content` is dropped; `kimi-k2.6` is the current
`balanced.general` / `balanced.vision` pick per the methodology's "Current
standing decision"). Running Eval-v1 against this exact set is the action
item the methodology names under `kimi-k2.6`: _"Eval-v1 (the Hetzner
scenario) quantifies its residual false-success rate before any deeper
intervention."_ A scorecard produced here is the evidence tier-1 input the
methodology expects for any future rule change — see
`packages/web/eval/model-selection-methodology.md` for the full evidence
hierarchy and how a scorecard is meant to feed back into the resolver
tier-map (always human-ratified, per rule R6).

## Extending the harness

- **New scenario**: add a new pure data module under `eval/scenarios/`
  (mirror `hetzner-invoice.ts`), a matching `ExpectedInvoice`-shaped (or new)
  expectation type in `src/lib/eval/types.ts` if the shape differs, and, for
  a deterministic self-test, new fake-ollama trigger constants following the
  `HETZNER_HAPPY_STEPS` / `runScriptedSequenceOpenAi` pattern in
  `fake-ollama-server.ts`.
- **New grader**: add a pure function to `graders.ts`, wire it into
  `gradeRun`'s `results` array, and add a fixture-based unit test — no
  orchestrator changes needed.
