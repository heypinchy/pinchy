/**
 * Drift guard: ensure model-resolver balanced-tier resolver outputs stay
 * in sync with BALANCED_ANCHORS (used in the setup wizard UI and
 * seedPersonalAgent). When a BALANCED_ANCHORS value is updated, the
 * corresponding provider resolver must be updated too, and vice versa.
 */
import { describe, expect, it } from "vitest";
import { BALANCED_ANCHORS } from "@/lib/provider-model-constants";
import { PROVIDERS } from "@/lib/providers";
import { getModelCatalogForProvider } from "@/lib/openclaw-builtin-models";
import { resolveAnthropic } from "@/lib/model-resolver/providers/anthropic";
import { resolveOpenAI } from "@/lib/model-resolver/providers/openai";
import { resolveGoogle } from "@/lib/model-resolver/providers/google";
import type { ModelTier } from "@/lib/model-resolver/types";

describe("balanced-tier sync: resolver outputs match BALANCED_ANCHORS", () => {
  it("anthropic balanced resolver output matches BALANCED_ANCHORS[anthropic]", () => {
    const r = resolveAnthropic({ tier: "balanced" });
    expect(r.model).toBe(BALANCED_ANCHORS["anthropic"]);
  });

  it("openai balanced resolver output matches BALANCED_ANCHORS[openai]", () => {
    const r = resolveOpenAI({ tier: "balanced" });
    expect(r.model).toBe(BALANCED_ANCHORS["openai"]);
  });

  it("google balanced resolver output matches BALANCED_ANCHORS[google]", () => {
    const r = resolveGoogle({ tier: "balanced" });
    expect(r.model).toBe(BALANCED_ANCHORS["google"]);
  });
});

// For anthropic/openai/google, getModelCatalogForProvider is what build.ts
// emits into openclaw.json and what seeds the capability table. A hardcoded
// pick outside it reaches an agent as a model Pinchy cannot vouch for: no
// vision row, so it drops out of the pdf/image chain and the knowledge-base OCR.
describe("every hardcoded pick is a curated model", () => {
  const RESOLVERS = {
    anthropic: resolveAnthropic,
    openai: resolveOpenAI,
    google: resolveGoogle,
  } as const;
  const TIERS: ModelTier[] = ["fast", "balanced", "reasoning"];

  for (const [provider, resolve] of Object.entries(RESOLVERS) as [
    keyof typeof RESOLVERS,
    (typeof RESOLVERS)[keyof typeof RESOLVERS],
  ][]) {
    const curated = getModelCatalogForProvider(provider).map((m) => `${provider}/${m.id}`);

    it.each(TIERS)(`${provider}: tier=%s resolves to a curated model`, (tier) => {
      expect(curated).toContain(resolve({ tier }).model);
    });

    it(`${provider}: BALANCED_ANCHORS and PROVIDERS.defaultModel are curated`, () => {
      expect(curated).toContain(BALANCED_ANCHORS[provider]);
      expect(curated).toContain(PROVIDERS[provider].defaultModel);
    });
  }
});
