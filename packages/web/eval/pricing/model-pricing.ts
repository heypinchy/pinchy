import type { OllamaCloudModelId } from "../../src/lib/ollama-cloud-models";

/**
 * Dated, source-verified market-rate price snapshot for the curated Ollama
 * Cloud catalog — the input to the published $ figure for pinchy#798.
 *
 * WHY a snapshot and not a live lookup: Pinchy runs these models over Ollama
 * Cloud, which is SUBSCRIPTION-billed (Free / Pro / Max plans), so there is no
 * per-token invoice to read back — `usage_records.estimatedCostUsd` is null for
 * every Ollama-Cloud run. The published "$ per completed task" is therefore a
 * MARKET-RATE PROXY: what the same open-weight model would cost per token if
 * bought from third-party inference hosters. It is NOT what we paid.
 *
 * Source + method (see pricing/README.md for the full contract):
 * - PRIMARY: OpenRouter's per-model pages, which publish a weighted-average
 *   across the providers actually serving each model. That "across providers"
 *   is the whole point — a single hoster's list price is not representative.
 * - CROSS-CHECK: Artificial Analysis provider tables + the direct list prices
 *   of Together / Fireworks / DeepInfra where a model is multi-hosted.
 * - RANGE, not a point: `inputMin..inputMax` / `outputMin..outputMax` bracket
 *   the spread across surveyed hosters (and first-party vs. realized-after-
 *   caching where they diverge). Publish the range; the median is derivable.
 *
 * `asOf` is the capture date and MUST move whenever the numbers do. Bleeding-
 * edge model prices drift fast, so the run-model-eval runbook re-captures this
 * table at each sweep so the published $ is dated to the data it labels. Git
 * history is the audit trail of prior snapshots.
 *
 * `entries` is typed `Record<OllamaCloudModelId, …>`, so adding/removing a
 * catalog model is a compile error here until this table is updated — the
 * price snapshot cannot silently drift out of sync with what we benchmark.
 */

export type PriceConfidence = "high" | "medium" | "approx";

/** USD per 1,000,000 tokens, as a range across the surveyed hosters. */
export interface ModelPriceEntry {
  inputMin: number;
  inputMax: number;
  outputMin: number;
  outputMax: number;
  confidence: PriceConfidence;
  /** Where the numbers came from + any caveat (variant, proxy, free tier). */
  note: string;
}

export interface PricingSnapshot {
  /** ISO date (YYYY-MM-DD) the prices were captured. */
  asOf: string;
  primarySource: string;
  crossCheck: string;
  entries: Record<OllamaCloudModelId, ModelPriceEntry>;
}

export const MODEL_PRICING: PricingSnapshot = {
  asOf: "2026-07-21",
  primarySource: "OpenRouter per-model pages (weighted-average across serving providers)",
  crossCheck:
    "Artificial Analysis provider tables; direct list prices from Together / Fireworks / DeepInfra where multi-hosted",
  entries: {
    "gemma4:31b": {
      inputMin: 0.1,
      inputMax: 0.14,
      outputMin: 0.35,
      outputMax: 0.35,
      confidence: "high",
      note: "OpenRouter $0.10/$0.35; TokenCost lists $0.14/M input — narrow spread.",
    },
    "glm-5.2": {
      inputMin: 0.447,
      inputMax: 0.447,
      outputMin: 3.31,
      outputMax: 3.31,
      confidence: "high",
      note: "OpenRouter weighted-avg (Jun 2026), confirmed twice across sources.",
    },
    "gpt-oss:20b": {
      inputMin: 0.05,
      inputMax: 0.07,
      outputMin: 0.2,
      outputMax: 0.3,
      confidence: "high",
      note: "Together $0.05/$0.20; Fireworks $0.07/$0.30.",
    },
    "gpt-oss:120b": {
      inputMin: 0.039,
      inputMax: 0.15,
      outputMin: 0.19,
      outputMax: 0.6,
      confidence: "high",
      note: "DeepInfra $0.039/$0.19 (cheapest); Together & Fireworks both $0.15/$0.60.",
    },
    "kimi-k2.6": {
      inputMin: 0.66,
      inputMax: 0.66,
      outputMin: 3.41,
      outputMax: 3.41,
      confidence: "high",
      note: "OpenRouter (Jul 2026).",
    },
    "kimi-k2.7-code": {
      inputMin: 0.66,
      inputMax: 0.66,
      outputMin: 3.41,
      outputMax: 3.41,
      confidence: "approx",
      note: "No direct listing found; proxied from kimi-k2.6 (same family). Re-capture at sweep.",
    },
    "minimax-m3": {
      inputMin: 0.098,
      inputMax: 0.3,
      outputMin: 1.2,
      outputMax: 1.21,
      confidence: "high",
      note: "OpenRouter weighted-avg (Jun 2026) $0.098/$1.21; first-party $0.30/$1.20.",
    },
    // nemotron-3-nano:30b's entry was removed on 2026-07-30 with the model
    // itself (it skipped tool calls in 4 of 5 probe rounds). The Record is keyed
    // by OllamaCloudModelId, so leaving a price for a model the catalog no
    // longer carries is a compile error rather than dead data — which is how
    // this one was found.
    "nemotron-3-super": {
      inputMin: 0.08,
      inputMax: 0.08,
      outputMin: 0.45,
      outputMax: 0.45,
      confidence: "high",
      note: "OpenRouter paid tier $0.08/$0.45; a $0 free tier also exists (not used for the proxy).",
    },
    "nemotron-3-ultra": {
      inputMin: 0.423,
      inputMax: 0.423,
      outputMin: 2.61,
      outputMax: 2.61,
      confidence: "high",
      note: "OpenRouter weighted-avg (Jun 2026).",
    },
  },
};
