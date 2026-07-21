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
    "deepseek-v4-flash": {
      inputMin: 0.054,
      inputMax: 0.14,
      outputMin: 0.242,
      outputMax: 0.28,
      confidence: "high",
      note: "OpenRouter weighted-avg (Jun 2026) realized $0.054/$0.242; DeepSeek first-party $0.14/$0.28.",
    },
    "deepseek-v4-pro": {
      inputMin: 0.435,
      inputMax: 0.435,
      outputMin: 0.87,
      outputMax: 0.87,
      confidence: "high",
      note: "OpenRouter (Jul 2026). Single canonical listing — no provider spread captured yet.",
    },
    "gemma4:31b": {
      inputMin: 0.1,
      inputMax: 0.14,
      outputMin: 0.35,
      outputMax: 0.35,
      confidence: "high",
      note: "OpenRouter $0.10/$0.35; TokenCost lists $0.14/M input — narrow spread.",
    },
    "glm-5.1": {
      inputMin: 0.966,
      inputMax: 0.966,
      outputMin: 3.036,
      outputMax: 3.036,
      confidence: "high",
      note: "OpenRouter (Jul 2026). Note: OR prices 5.1 ABOVE 5.2 — 5.1 is the less price-optimized release.",
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
    "kimi-k2.5": {
      inputMin: 0.6,
      inputMax: 0.6,
      outputMin: 2.0,
      outputMax: 3.0,
      confidence: "medium",
      note: "OpenRouter input $0.60; output varies by provider (~$2.00–3.00). Re-capture at sweep.",
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
    "minimax-m2.5": {
      inputMin: 0.24,
      inputMax: 0.24,
      outputMin: 0.96,
      outputMax: 0.96,
      confidence: "approx",
      note: "No direct listing found; proxied from minimax-m2.7 (same family). Re-capture at sweep.",
    },
    "minimax-m2.7": {
      inputMin: 0.24,
      inputMax: 0.24,
      outputMin: 0.96,
      outputMax: 0.96,
      confidence: "high",
      note: "OpenRouter (Jul 2026).",
    },
    "minimax-m3": {
      inputMin: 0.098,
      inputMax: 0.3,
      outputMin: 1.2,
      outputMax: 1.21,
      confidence: "high",
      note: "OpenRouter weighted-avg (Jun 2026) $0.098/$1.21; first-party $0.30/$1.20.",
    },
    "mistral-large-3:675b": {
      inputMin: 0.5,
      inputMax: 0.5,
      outputMin: 1.5,
      outputMax: 1.5,
      confidence: "medium",
      note: "OpenRouter Mistral Large 3 (2512) (Jul 2026). Single listing — verify the 675B open-weight variant at sweep.",
    },
    "nemotron-3-nano:30b": {
      inputMin: 0.05,
      inputMax: 0.05,
      outputMin: 0.2,
      outputMax: 0.2,
      confidence: "high",
      note: "OpenRouter paid tier $0.05/$0.20; a $0 free tier also exists (not used for the proxy).",
    },
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
    "qwen3.5:397b": {
      inputMin: 0.3,
      inputMax: 0.5,
      outputMin: 1.56,
      outputMax: 2.0,
      confidence: "approx",
      note: "397B open-weight not directly listed on aggregators; bracketed above Qwen3.5-Plus ($0.26/$1.56) for the flagship size. Re-capture at sweep.",
    },
  },
};
