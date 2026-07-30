---
name: update-ollama-cloud-models
description: Use when a new Ollama Cloud model is announced or available (e.g. an ollama-cloud email about a new GLM/Qwen/DeepSeek/Kimi/MiniMax version), when preparing a Pinchy release, or when the curated Ollama Cloud model list may have drifted from ollama.com.
---

# Update the Ollama Cloud model list

## Overview

Pinchy curates the tool-capable Ollama Cloud models it surfaces in
`packages/web/src/lib/ollama-cloud-models.ts`. This skill keeps that list
fresh and correct when Ollama adds, removes, or resizes models.

**Core principle: never trust the `ollama.com/library/<name>` capability tags.**
They lie — `devstral-small-2` and `qwen3.5` advertise vision but hallucinate
image contents; `gemini-3-flash-preview` advertises tools but leaks the call as
plain text. Every `vision`/`reasoning` flag in the list is set from what the
**live API actually does**, not from what a page claims. The whole file exists
because the tags are unreliable. Setting a flag from a library page instead of a
probe is the one mistake this skill is here to prevent.

## When to use

- An ollama-cloud email/announcement mentions a new model or version.
- Preparing a Pinchy release (this is a pre-release checklist item — run it
  even for tiny releases).
- **Before any Eval-v1 sweep** (iron rule 1 of the `run-model-eval` skill). The
  benchmark's whole claim is that it measures what the provider actually serves
  today, so a sweep against a drifted catalog is worse than no sweep: it burns
  hours on models that 404, and publishes a model set the provider retired. This
  is not hypothetical — Ollama retired `deepseek-v3.2` and `glm-4.7` on
  2026-07-15 and the catalog still carried both two days later, because nothing
  in either skill said to check before a sweep.
- You suspect the catalog drifted (a model 404s, a tier pick feels stale).

Do **not** add a model from its library page alone, ever. No key → no verified
flags → no add (see "If you have no API key").

## Prerequisite

The probes hit the live API and need a key:

```bash
export OLLAMA_CLOUD_API_KEY=...   # an Ollama Pro/Max key
```

Without it every script below skips with exit 0 — useful in CI, useless for
actually verifying. Ask the user for the key; do not guess flags to work around
a missing key.

**The working key lives in `~/.openclaw/openclaw.json`** →
`models.providers.ollama-cloud.apiKey`. The repo-root `.env` also defines
`OLLAMA_CLOUD_API_KEY` and its copy was **expired** on 2026-07-30 — same length,
different value — so prefer the OpenClaw config and treat `.env` as a fallback.
Never print either.

**Verify the key before you trust a sweep.** `/v1/models` and `/api/show` are
**public**: `pnpm models:discover` returns a full, correct delta with a dead key,
and `/api/show` reports capabilities and context length too. Only
`/v1/chat/completions` is authenticated. So a green discovery step says nothing
about the key, and the first thing you learn otherwise is `DRIFT (round 1 HTTP
401)` on every model — which reads like a catalog catastrophe. One cheap check:

```bash
pnpm models:verify:tools --only=glm-5.2
```

A `401` there is the key, not the catalog.

## Source of truth and everything derived from it

`ollama-cloud-models.ts` is the single source. When you change it, re-check
these derived sites in the SAME change:

| Site                                                                        | What to check                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model-resolver/providers/ollama-cloud.ts`                                  | Per-tier `general`/`coder`/`vision` picks. Does a new model deserve to lead a tier? Did a removed model leave a dangling pick? (The `OllamaCloudModelId` union makes a removed ID a `tsc` error here.)                                          |
| `model-resolver/families.ts`                                                | Family prefix lists — add a prefix only for a genuinely new family. (Local-resolver prefixes; not coupled to the cloud catalog, so a removed cloud model does not force a change here.)                                                         |
| `model-resolver/blocklist.ts`                                               | If a model emits tools but leaks them as text (gemini-3 case), block it instead of dropping it, so it stays usable for chat-only agents.                                                                                                        |
| `openclaw-config/default-media-models.ts` → `OLLAMA_CLOUD_IMAGE_PREFERENCE` | The ordered best-vision image-fallback picks. Removing a model that appears here breaks the `ollama-cloud-image-preference-drift` test; re-point to another vision-verified model. Removing/demoting a vision model means dropping it here too. |
| `__tests__/lib/ollama-cloud-models.test.ts`                                 | Add a dated, empirical assertion pinning each non-obvious flag (see step 5).                                                                                                                                                                    |

## Procedure

1. **Discover the delta.** `pnpm models:discover`.
   - `REMOVED` = a curated model is gone upstream → drop it (step 6). The run
     exits non-zero so this is never silent.
   - `ADDED` = served models we don't carry. `/v1/models` has no capability
     tags, so this includes chat-only models. Triage, don't bulk-add.

2. **Narrow ADDED to tool-capable cloud candidates.** Cross-check each against
   `ollama.com/library/<name>` and `ollama.com/search?c=tools&c=cloud`. The
   search page is incomplete — trust the individual library page. A model with
   no "tools" tag is not a candidate (every Pinchy agent uses tools).

3. **Read each candidate's library page** for:
   - **context window** → `contextWindow`. Ollama uses "NK" = N × 1024
     (`160K` → 163840). For a "up to X / minimum Y" model, use the guaranteed
     floor (e.g. minimax-m3 → 524288).
   - whether it carries the **thinking** tag → provisional `reasoning`.
   - whether it claims **Image** input → provisional `vision` (to be verified, not trusted).
   - `maxTokens`: 8192 by default; use the higher value only for output-heavy
     Gemini-Flash-class models.

4. **Add a provisional entry** to `TOOL_CAPABLE_OLLAMA_CLOUD_MODELS` (alphabetical
   within its family block) with your provisional flags. Keep `cost` zero — Ollama
   Cloud is subscription-billed, not per-token.

5. **Verify empirically and set flags from the RESULT:**

   ```bash
   pnpm models:verify:tools --only=<id>     # round-1 tool_call + multi-turn follow-up
   pnpm models:verify:vision --only=<id>    # only if you set vision:true
   ```

   - `models:verify:tools` probes **two rounds**: a structured tool_call, then a
     follow-up after a tool result. Both must pass. This catches the gemma3 /
     kimi-k2-thinking failure mode (clean single-turn call, then HTTP 500 once
     the history carries a tool result) that single-turn probing misses.
   - **A single passing run is a smoke test, not a reliability proof.** Some
     models are intermittent — qwen3-next emits a clean call 3 of 4 rounds, and
     gemma3 flip-flopped from multi-turn-500 (2026-06-12) to passing (2026-06-17).
     For a **new** addition, run the probe several times before trusting it; the
     existing catalog entries cite "4/4 rounds" for exactly this reason.
   - Tools drift (empty content, or leaked-as-text) → the model is **not**
     tool-capable. If it leaks but is otherwise good for chat, add it to the
     blocklist rather than the catalog. If it just never calls, drop it.
   - Vision: the probe now checks **sight, not acceptance** — it sends a 512x512
     fixture carrying the number 7413 and requires the model to report it, so
     the accepted-but-hallucinated case (qwen3.5, 2026-06) fails on its own
     instead of needing a manual follow-up. Verdicts: `ok`, `drift`,
     `fixture-rejected`, `unexpected`. When genuinely unsure, still prefer
     `vision:false` (conservative side).
   - **A vision DRIFT report can be the probe's own fault.** On 2026-07-30 the
     pinned 64x64 fixture had become undecodable to Ollama's backends and the
     sweep reported 6 of 18 models as drift; obeying it would have flipped six
     correct flags. Tell the two apart by the shape of the failure: if models
     that merely reject images by policy pass while every model that actually
     decodes one fails, the fixture is dead, not the fleet. `fixture-rejected`
     exists to say so — **never flip a flag on a decode complaint.** Regenerate
     the fixture (well above 256x256) and re-run.
   - `gemma4:31b` HTTP 500s on roughly half its image requests. The probe retries
     transient statuses; a `500` is never read as "no vision".
   - Record the verdict + date in a code comment, matching the existing entries.
     When you REVERSE an earlier verdict, say so and keep the old reasoning
     visible — `kimi-k2.7-code` and `qwen3.5:397b` were both `vision:false` for a
     month, and a bare `vision: true` invites the next reader to "fix" it back.

6. **Handle REMOVED.** Delete the stale entry, then fix any `tsc` error it
   surfaces in `providers/ollama-cloud.ts` (re-point the tier).

7. **Update the drift tests.** The catalog is snapshotted in several tests —
   adding/removing a model drifts ALL of them, not just the first one:
   - `__tests__/lib/ollama-cloud-models.test.ts` — add a dated, empirical
     assertion for each non-obvious flag (the TDD record of what you verified).
   - `__tests__/lib/provider-models.test.ts` — model-ID lists + a hardcoded
     count (`toHaveLength`).
   - `__tests__/lib/openclaw-config.test.ts` — the written-config list, the
     per-model `contextWindow`, and the `reasoning`/`input` lists.
   - `__tests__/lib/model-vision.integration.test.ts` — `isModelVisionCapable`
     assertions (DB-backed; only `pnpm test:db` runs it, not `pnpm test`).
   - `__tests__/lib/model-capabilities/seed.integration.test.ts` — DB-backed too,
     and it asserts a FLOOR on the built-in model count (`>= 30` until the
     2026-07-15 wave cut the catalog to 18). A retirement trips it.
   - `__tests__/lib/ollama-cloud-image-preference-drift.test.ts` — guards the
     image-preference list.
   - `__tests__/lib/vision-model-chain.test.ts` — its fixture simulates the LIVE
     cloud catalog, so a retired vision model must be swapped there too.
   - `src/lib/model-resolver/__tests__/ollama-cloud.test.ts` — NOTE the path: it
     sits under `src/lib/model-resolver/`, not under `src/__tests__/lib/` where
     the other catalog drift tests live. (A duplicate under `src/__tests__/lib/`
     is gone as of 2026-07-30 — glob for `*ollama-cloud*.test.ts` rather than
     trusting this list, so a moved file surfaces as a missing path.)
   - `scripts/lib/ollama-cloud-source.test.mjs` — run by `pnpm test:scripts`,
     NOT by `pnpm test`. It pins one model's fields as a parser fixture and
     asserts a catalog-size floor; both break on a retirement.

8. **Run the gates** — the FULL suites, not just the one drift test. A removed
   model drifts unit AND DB-backed snapshots; `pnpm test` alone misses the
   `*.integration.test.ts` ones (that gap cost a red CI run once):

   ```bash
   pnpm test:scripts
   pnpm -C packages/web test          # full unit suite — all the snapshot tests
   pnpm -C packages/web test:db       # DB-backed: model-vision.integration etc.
   pnpm -C packages/web typecheck     # incl. tests; the ID union catches stale refs
   pnpm format:check
   ```

   `test:db` needs a Postgres on this worktree's allocated port. `pnpm
worktree:env` writes the allocation, then start one with the DB name the
   suite expects:

   ```bash
   docker run -d --name pinchy-<slug>-testdb -e POSTGRES_USER=pinchy -e POSTGRES_PASSWORD=pinchy_dev -e POSTGRES_DB=pinchy_test_vitest -p <DEV_DB_PORT>:5432 pgvector/pgvector:pg17-trixie
   ```

   The union is the gate that finds references the drift tests miss — removing
   `nemotron-3-nano:30b` surfaced a stale `eval/pricing/model-pricing.ts` entry
   that no test covers.

## If you have no API key

Do steps 1–4 and 6 as far as the data goes (discovery, library-page context
windows, removals), but **stop before setting `vision`/`reasoning` from
guesses**. Leave the candidate out and hand the verification commands
(`pnpm models:verify:tools/vision --only=<id>`) to whoever has the key. Shipping
an unverified capability flag is exactly the CISO-unfriendly drift this skill
prevents.

## Common mistakes

| Mistake                                            | Fix                                                                                                                                       |
| -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Set `vision:true` from the library page            | Probe it. Pages lie.                                                                                                                      |
| Treated `models:discover` ADDED as "add all"       | ADDED includes chat-only models; triage against library tags.                                                                             |
| Read a green `models:discover` as a working key    | Both discovery endpoints are public. Only a chat completion proves the key.                                                               |
| Flipped flags on a vision DRIFT report             | Check whether the FIXTURE died first — see step 5. A decode complaint is never a model verdict.                                           |
| Forgot the tier picks / blocklist                  | A new leader or a leaky model needs `providers/ollama-cloud.ts` / `blocklist.ts` updated too.                                             |
| Promoted a newly-sighted model into a ranked list  | `OLLAMA_CLOUD_IMAGE_PREFERENCE` and the tier vision slots rank on comparative eval data. Reading the fixture proves capability, not rank. |
| Dropped a leaky-but-good model entirely            | Blocklist it instead — it stays usable for chat-only agents.                                                                              |
| Skipped the dated test assertion                   | The empirical record is the point; future-you will re-trust a page without it.                                                            |
| Reverted a canary with `git checkout <file>`       | The catalog file carries uncommitted work — the checkout silently discards it. Undo the canary with the inverse edit.                     |
| Assumed a served, correctly-tagged model is usable | `kimi-k3` (2026-07-30) matched every criterion and 402s on every request: extra-usage-only billing, not included plan usage.              |

## Quick reference

```bash
pnpm models:discover                       # delta vs ollama.com/v1/models
pnpm models:verify:tools  [--only=<id>]    # structured tool_calls check
pnpm models:verify:vision [--only=<id>]    # live image-input check
```
