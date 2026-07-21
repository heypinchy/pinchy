# Elicitation protocol — proving a fair scaffold (pinchy#800)

The strongest objection to any per-model reliability number is **"you just
integrated model X badly."** This document is the answer: it states exactly how
every model is elicited, so a low score is a property of the model on our real
serving path — not of a scaffold we under-built for it. It follows the METR
elicitation-protocol framing (https://evaluations.metr.org/elicitation-protocol/)
and is part of the methodology (`model-selection-methodology.md` sits above it).

## The core fairness property: there is no eval-special scaffold

Eval-v1 does not build a bespoke agent for each model. It drives the **real
Pinchy production path** end to end: `dispatchAndScrape` (`eval/run-eval.ts`)
types the task into the actual chat UI and scrapes the assistant's final
message, exactly as a Pinchy user would. The agent, its tools, its system
prompt, and its OpenClaw config are the same objects a customer gets.

This is the whole fairness argument in one line: **every model is elicited the
way Pinchy actually runs it.** A number here is not "model X in a lab rig" — it
is "model X as a Pinchy customer would deploy it." We cannot be accused of a
hand-tuned scaffold because there is no scaffold to tune.

## Sampling and decoding — uniform, provider-default, untuned

Pinchy sets **no** per-model sampling parameters. It writes no `temperature`,
`top_p`, `top_k`, or seed into `openclaw.json`, so every model runs on the
OpenClaw / Ollama Cloud `/v1` provider defaults. Verified by absence:
`rg 'temperature|top_p|sampling'` over `src/lib/openclaw-config/` is empty.

- **No per-model tuning means no per-model advantage.** We do not sweep
  temperature to flatter one model, because the product does not, and the eval
  is the product.
- **Thinking is on by default and not per-model toggled.** OpenClaw defaults
  `reasoning_effort` to `"high"` and Pinchy never sets `ChatOptions.thinking`,
  so a thinking-by-default model thinks; a catalog `reasoning:false` model does
  not. This is model-level, emitted uniformly from the catalog flag — see
  methodology **R5**. It is a documented property of each model, not a knob we
  turned for some and not others.
- **Runs are independent samples.** N=12 per cell are separate dispatches
  against freshly reset+seeded mocks (`eval/eval-shared.ts`), so the only
  variation between a cell's runs is the model's own nondeterminism on the
  provider defaults.

## Per-model configuration — one source of truth, every difference justified

The only per-model differences are the catalog entries in
`src/lib/ollama-cloud-models.ts`, and each one carries an inline justification.
Rather than duplicate a table that would drift, this doc points at the catalog
as the source of truth and states the invariants:

- `maxTokens` is a uniform 8192 output hint across every catalog entry, with no
  per-model exception — a shared output ceiling can advantage no one model.
- `reasoning` and `vision` are read from each model's `ollama.com/library`
  capability tags, then **corrected against the live `/v1` endpoint** where the
  page lies (e.g. a model that advertises vision but returns HTTP 500 on an
  `image_url` payload is flagged `vision:false`). The corrections are the
  fairness-relevant part: we do not hand a model an input its serving path can't
  take and then score the failure.
- `contextTokens` (a runtime context-budget cap below the native window) is set
  for **exactly one** model, `deepseek-v4-pro`, and only because its long-context
  quality knees well before its advertised 512K and an uncapped budget produced
  a real confabulation incident ("Piper", 2026-07-15). Capping it makes
  OpenClaw's compaction fire in time — a correction that helps the model, not a
  handicap. No other model is capped.

## Tool-call elicitation and known serving quirks

Every model is given the same tools, registered by the Pinchy plugins, in the
same OpenAI-style tool schema. Two serving-layer realities shape what "fair"
means here, and both are handled at the platform, not by penalizing a model:

- **The `/v1` tool-arg encoding.** Ollama's `/v1` path rejects object-valued
  tool arguments with a 400 on some models — the failure mode the `line-items`
  scenario (nested `invoice_line_ids` command triplets) exists to surface. A
  model that cannot emit the required nested arguments over this path fails the
  scenario; that is a real capability result on our serving path, and it is why
  the scenario is in the suite.
- **Tool-call-as-text leaks.** Some models emit a tool call as plain assistant
  text instead of a structured `tool_calls` payload (the `default_api`
  signature; historically Gemini-family). Where this is a known, persistent
  break rather than model behavior we want to measure, the model is in the
  tools-blocklist (pinchy#344) and never wired into a slot — it is excluded, not
  scored as a failure.

Known per-model serving issues are already held in the catalog comments and the
methodology's R-rules (gemma cross-turn id corruption; glm loop when
`reasoning_content` is dropped; kimi native vision unreliable over `/v1`;
deepseek-v4-pro context knee). This doc consolidates them by reference so the
"we already know this informally" objection has a written home.

## Retry and timeout policy — no silent re-rolls

- **No run is retried to improve its outcome.** A dispatch is graded once. The
  `attempt < 24` loop in `scrapeFinalAssistantMessage` is a 6-second poll for
  the final message to stabilize, not a re-run of the task.
- **A model hang is a model failure.** A run that never stops generating hits a
  5-minute cap and is tagged `run-timeout`, graded as a failure — it is model
  behavior, and re-rolling it would launder unreliability into a better score.
- **A transport death is an invalid trial, not a failure.** When the LLM request
  itself dies (the model never answered), the run is tagged `run-infra-error`,
  **excluded** from the cell's n, and the cell is marked `pendingRerun` until
  coverage is restored (`export-scorecard.ts`). We never credit an infra error
  as either a pass or a model failure.

## Spurious vs. real failures (the classification)

METR's second half is labeling each failing cell's dominant failure as a
**spurious bottleneck** (fixable by us: tool format, prompt, scaffold, a serving
quirk we could route around) vs. a **real failure** (the model, fairly elicited,
did the wrong thing). The rule that keeps this honest:

- A **spurious** bottleneck is a bug report against the harness, not the model.
  It must produce a concrete harness fix and a re-run — it never stands as a
  published model result. (The uniform-0%-amount artifact in the first sweep is
  the archetype: a mock-fidelity defect, fixed, not a model ranking.)
- A **real** failure stands, read next to the happy-path score so incapacity is
  never mistaken for diligence (the confound the methodology already flags for
  mistral-large-3 / gpt-oss).

The per-cell labeling is a **one-time review of trajectories** and is therefore
done **against the dataset it describes**: it is deferred to the re-sweep's fresh
18-model trajectories, because labeling the superseded cohort would be discarded
when the new dataset lands. This document is the durable half — the protocol that
proves fair elicitation regardless of which cohort is current; the per-cohort
labels attach to each published sweep.
