/**
 * Client-safe model constants — no server-only imports.
 *
 * This file is intentionally kept free of database, settings, or encryption
 * imports so it can be consumed by both client components and server code.
 */

import type { ProviderName } from "@/lib/providers";

/**
 * Preferred balanced-tier model IDs, one per provider, used as the fallback
 * when selectDefaultModel() cannot match any live model against BALANCED_PATTERNS.
 * These values are also shown directly in client-side UI (e.g. the setup wizard
 * success screen) without a live model fetch.
 */
export const BALANCED_ANCHORS: Record<ProviderName, string> = {
  anthropic: "anthropic/claude-sonnet-4-6",
  openai: "openai/gpt-5.5",
  google: "google/gemini-2.5-pro",
  "ollama-cloud": "ollama-cloud/glm-4.7",
  "ollama-local": "",
};
