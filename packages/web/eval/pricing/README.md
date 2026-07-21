# Cost methodology — the published `$ per completed task` (pinchy#798)

This directory holds the **price snapshot** (`model-pricing.ts`) that turns the
per-run token counts captured in #798 into the `$` figure we publish next to
each model. It is the "verified price source" the reliability hub cites.

## Why it's a proxy, not an invoice

Pinchy runs every benchmarked model over **Ollama Cloud**, which is
**subscription-billed** (Free / Pro / Max plans), not per-token. There is no
per-token invoice to read back — `usage_records.estimated_cost_usd` is `null`
for every Ollama-Cloud run, so `RunResult.tokens.costUsd` is absent.

The published `$` is therefore a **market-rate proxy**: what the _same
open-weight model_ would cost per token if bought from third-party inference
hosters. It answers "if you self-hosted or bought this model's tokens on the
open market, what would this task cost?" — **not** "what did we pay Ollama."
Every surface that shows the `$` must label it that way.

## The source (why it's credible)

Single-hoster list prices are not representative — the same open-weight model is
served by many hosters at prices that routinely differ 3–4×. So the primary
source is the one that already aggregates _across providers_:

- **PRIMARY — OpenRouter per-model pages.** OpenRouter publishes a
  **weighted-average across the providers actually serving each model**, plus
  the individual provider prices. That cross-provider average is the number we
  anchor on.
- **CROSS-CHECK — Artificial Analysis** provider tables (price + the AA
  intelligence index), and the **direct list prices of Together / Fireworks /
  DeepInfra** where a model is multi-hosted.

Both are widely-cited, vendor-neutral aggregators, which is the bar for a public
comparison that won't be dismissed as a marketing benchmark.

## Range, not a point — and dated

Each entry brackets the spread we found across surveyed hosters
(`inputMin..inputMax` / `outputMin..outputMax`, USD per 1,000,000 tokens),
including first-party-vs-realized-after-caching where those diverge. We publish
the **range**; the median is derivable from it. Reporting a single number would
hide the 3–4× serving spread that is itself a real finding.

`MODEL_PRICING.asOf` is the **capture date**, shown for transparency. Bleeding-
edge model prices drift fast, so this table is **re-captured at each sweep** (see
the run-model-eval runbook) so the published `$` is dated to the data it labels.
Git history is the audit trail of prior snapshots.

`confidence` is honest about each row:

- `high` — a direct listing (usually OpenRouter), often cross-checked.
- `medium` — a single listing, or a variant match that wants a sweep-time re-check.
- `approx` — no direct listing for that exact model/size; bracketed from a
  same-family neighbour or a sized-up commercial variant. **Must** be
  re-captured before the number is published.

## The offline computation

The `$` is computed **offline from the captured token counts**, never from the
`estimated_cost_usd` column (which is null here). Per run:

```
runCostUsd = prompt_tokens / 1e6 * inputPrice
           + completion_tokens / 1e6 * outputPrice
```

evaluated at both ends of the price range to yield a `[min, max]` per run, then
reduced over the **passing** runs (mirroring `medianTokensPerCompletedTask`, the
published token metric) to a per-model published `$` range. `prompt` here is the
#798 sum of all three prompt classes (`input + cacheRead + cacheWrite`), so the
input side isn't under-counted on caching hosters.

> The computation and its wiring into `export-scorecard.ts` land with the
> re-sweep, when real captured tokens exist to validate the output shape against.
> This directory ships the **verified source + method** that computation reads.

## Updating this table

1. For each id in the curated catalog, open its OpenRouter model page; record the
   weighted-average and the provider min/max into `inputMin/Max`, `outputMin/Max`.
2. Cross-check against Artificial Analysis / a direct hoster where listed.
3. Set `confidence` and a one-line `note` with the provenance.
4. Bump `asOf` to the capture date.
5. `pnpm -C packages/web test eval/pricing` — the parity guard fails if the
   catalog gained/lost a model, and the shape guard fails on an incoherent range.

The `Record<OllamaCloudModelId, …>` type makes a missing/extra id a **compile
error**, so the snapshot cannot silently drift out of sync with what we benchmark.
