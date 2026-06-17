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

## Source of truth and everything derived from it

`ollama-cloud-models.ts` is the single source. When you change it, re-check
these derived sites in the SAME change:

| Site | What to check |
|------|---------------|
| `model-resolver/providers/ollama-cloud.ts` | Per-tier `general`/`coder`/`vision` picks. Does a new model deserve to lead a tier? Did a removed model leave a dangling pick? (The `OllamaCloudModelId` union makes a removed ID a `tsc` error here.) |
| `model-resolver/families.ts` | Family prefix lists — add a prefix only for a genuinely new family. (Local-resolver prefixes; not coupled to the cloud catalog, so a removed cloud model does not force a change here.) |
| `model-resolver/blocklist.ts` | If a model emits tools but leaks them as text (gemini-3 case), block it instead of dropping it, so it stays usable for chat-only agents. |
| `openclaw-config/default-media-models.ts` → `OLLAMA_CLOUD_IMAGE_PREFERENCE` | The ordered best-vision image-fallback picks. Removing a model that appears here breaks the `ollama-cloud-image-preference-drift` test; re-point to another vision-verified model. Removing/demoting a vision model means dropping it here too. |
| `__tests__/lib/ollama-cloud-models.test.ts` | Add a dated, empirical assertion pinning each non-obvious flag (see step 5). |

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
   - Vision: `OK (api accepts)` confirms `vision:true`. `DRIFT (flag=true but
     API rejects)` → `vision:false`. **The script only catches outright
     rejection** — a model that returns HTTP 200 but hallucinates the image
     (qwen3.5) still needs the manual number+color check described in the test
     file header. When unsure, set `vision:false` (conservative side).
   - Record the verdict + date in a code comment, matching the existing entries.

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
   - `__tests__/lib/ollama-cloud-image-preference-drift.test.ts` — guards the
     image-preference list.

8. **Run the gates** — the FULL suites, not just the one drift test. A removed
   model drifts unit AND DB-backed snapshots; `pnpm test` alone misses the
   `*.integration.test.ts` ones (that gap cost a red CI run once):

   ```bash
   pnpm test:scripts
   pnpm -C packages/web test          # full unit suite — all the snapshot tests
   pnpm -C packages/web test:db       # DB-backed: model-vision.integration etc.
   pnpm -C packages/web exec tsc --noEmit   # union catches stale IDs in resolvers
   ```

## If you have no API key

Do steps 1–4 and 6 as far as the data goes (discovery, library-page context
windows, removals), but **stop before setting `vision`/`reasoning` from
guesses**. Leave the candidate out and hand the verification commands
(`pnpm models:verify:tools/vision --only=<id>`) to whoever has the key. Shipping
an unverified capability flag is exactly the CISO-unfriendly drift this skill
prevents.

## Common mistakes

| Mistake | Fix |
|---------|-----|
| Set `vision:true` from the library page | Probe it. Pages lie. |
| Treated `models:discover` ADDED as "add all" | ADDED includes chat-only models; triage against library tags. |
| Forgot the tier picks / blocklist | A new leader or a leaky model needs `providers/ollama-cloud.ts` / `blocklist.ts` updated too. |
| Dropped a leaky-but-good model entirely | Blocklist it instead — it stays usable for chat-only agents. |
| Skipped the dated test assertion | The empirical record is the point; future-you will re-trust a page without it. |

## Quick reference

```bash
pnpm models:discover                       # delta vs ollama.com/v1/models
pnpm models:verify:tools  [--only=<id>]    # structured tool_calls check
pnpm models:verify:vision [--only=<id>]    # live image-input check
```
