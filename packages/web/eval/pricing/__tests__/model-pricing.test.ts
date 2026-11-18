import { describe, expect, it } from "vitest";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS } from "../../../src/lib/ollama-cloud-models";
import { MODEL_PRICING } from "../model-pricing";

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
