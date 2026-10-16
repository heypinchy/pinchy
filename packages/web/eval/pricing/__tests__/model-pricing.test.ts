import { describe, expect, it } from "vitest";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS } from "../../../src/lib/ollama-cloud-models";
import { getModelCatalogForProvider } from "../../../src/lib/openclaw-builtin-models";
import { FIRST_PARTY_PRICING, MODEL_PRICING } from "../model-pricing";

/**
 * Guards the checked-in price snapshot that feeds the published $ figure for
 * pinchy#798. The prices themselves are a dated, hand-captured market-rate
 * proxy (Ollama Cloud is subscription-billed — see pricing/README.md); these
 * tests only enforce that the snapshot stays STRUCTURALLY honest and in sync
 * with the curated catalog, so a catalog change can't silently orphan a price.
 */
describe("MODEL_PRICING snapshot", () => {
  it("carries an ISO capture date and named primary + cross-check sources", () => {
    expect(MODEL_PRICING.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(MODEL_PRICING.primarySource).toMatch(/OpenRouter/i);
    expect(MODEL_PRICING.crossCheck.length).toBeGreaterThan(0);
  });

  it("prices every curated catalog model and only those (parity with the catalog)", () => {
    const priced = Object.keys(MODEL_PRICING.entries).sort();
    const curated = [...TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS].sort();
    expect(priced).toEqual(curated);
  });

  it("has coherent, non-negative price ranges (0 ≤ min ≤ max)", () => {
    for (const [id, e] of Object.entries(MODEL_PRICING.entries)) {
      expect(e.inputMin, id).toBeGreaterThanOrEqual(0);
      expect(e.outputMin, id).toBeGreaterThanOrEqual(0);
      expect(e.inputMax, id).toBeGreaterThanOrEqual(e.inputMin);
      expect(e.outputMax, id).toBeGreaterThanOrEqual(e.outputMin);
    }
  });

  it("labels every entry with a confidence level and a provenance note", () => {
    for (const [id, e] of Object.entries(MODEL_PRICING.entries)) {
      expect(["high", "medium", "approx"], id).toContain(e.confidence);
      expect(e.note.trim().length, id).toBeGreaterThan(0);
    }
  });

  it("keeps every price plausibly bounded (< $50 / M tokens) so a typo can't silently 100× the published cost", () => {
    for (const [id, e] of Object.entries(MODEL_PRICING.entries)) {
      expect(e.inputMax, id).toBeLessThan(50);
      expect(e.outputMax, id).toBeLessThan(50);
    }
  });
});

/**
 * Models billed per token by their own vendor need no proxy: the list price IS
 * the invoice rate. Their source of truth inside Pinchy is the curated catalog
 * that build.ts emits to OpenClaw (the `cost` OpenClaw meters usage with), so
 * this table must agree with it rather than become a second, drifting copy.
 */
describe("FIRST_PARTY_PRICING snapshot", () => {
  const anthropicCatalog = new Map(
    getModelCatalogForProvider("anthropic").map((m) => [`anthropic/${m.id}`, m])
  );

  it("carries an ISO capture date and the vendor's own pricing page as source", () => {
    expect(FIRST_PARTY_PRICING.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(FIRST_PARTY_PRICING.source).toBe(
      "https://platform.claude.com/docs/en/about-claude/pricing"
    );
  });

  it("prices the Anthropic candidates of the knowledge-base eval", () => {
    expect(Object.keys(FIRST_PARTY_PRICING.entries)).toEqual(
      expect.arrayContaining([
        "anthropic/claude-haiku-5-5",
        "anthropic/claude-sonnet-5",
        "anthropic/claude-sonnet-5-5",
      ])
    );
  });

  it("only prices curated models, at exactly the rate the catalog meters with", () => {
    for (const [id, entry] of Object.entries(FIRST_PARTY_PRICING.entries)) {
      const curated = anthropicCatalog.get(id);
      expect(curated, `${id} is not in the curated anthropic catalog`).toBeDefined();
      expect(entry.standard, id).toEqual(curated!.cost);
      expect(entry.note.trim().length, id).toBeGreaterThan(0);
    }
  });

  it("records Haiku 5.5's prompt-length tier, and no tier for models priced flat", () => {
    const haiku = FIRST_PARTY_PRICING.entries["anthropic/claude-haiku-5-5"];
    expect(haiku.longPrompt).toEqual({
      aboveTokens: 100000,
      input: 0.5,
      output: 2.5,
      cacheRead: 0.05,
      cacheWrite: 0.625,
    });
    for (const [id, entry] of Object.entries(FIRST_PARTY_PRICING.entries)) {
      if (id !== "anthropic/claude-haiku-5-5") expect(entry.longPrompt, id).toBeUndefined();
    }
  });
});
