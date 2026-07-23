import { describe, it, expect } from "vitest";
import { lookupModelCapabilities, DEFAULT_MODEL_CAPS } from "@/lib/model-catalog";

describe("lookupModelCapabilities", () => {
  it("resolves a known open-weight model to full capabilities", () => {
    const caps = lookupModelCapabilities("mistral-large-2512");
    expect(caps).not.toBeNull();
    expect(caps!.cost).toHaveProperty("cacheRead");
    expect(caps!.contextWindow).toBeGreaterThan(0);
    expect(caps!.input).toContain("text");
  });

  it("matches a provider-prefixed / renamed id by family", () => {
    // Sovereign endpoints rename models; family match must still resolve.
    const caps = lookupModelCapabilities("swisscom/mistral-large-2512");
    expect(caps).not.toBeNull();
  });

  it("returns null for a truly unknown id", () => {
    expect(lookupModelCapabilities("totally-made-up-model-xyz")).toBeNull();
  });

  it("DEFAULT_MODEL_CAPS is compaction-safe (small context, tools on, vision off)", () => {
    expect(DEFAULT_MODEL_CAPS.contextWindow).toBe(32768);
    expect(DEFAULT_MODEL_CAPS.vision).toBe(false);
    expect(DEFAULT_MODEL_CAPS.input).toEqual(["text"]);
    expect(DEFAULT_MODEL_CAPS.cost).toEqual({
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
});
