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

  it("resolves a full canonical snapshot key and de-prefixes the id", () => {
    // Exercises the exact-match branch: a full `provider/model` key resolves,
    // and the returned id must NOT carry the provider prefix (OpenClaw derives
    // the qualified id from the provider block + this local id).
    const caps = lookupModelCapabilities("mistral/mistral-large-2512");
    expect(caps).not.toBeNull();
    expect(caps!.id).toBe("mistral-large-2512");
    expect(caps!.id).not.toContain("/");
  });

  it("returns null for an ambiguous bare family id (multi-member family)", () => {
    // `qwen` has 32 members in the snapshot. A bare family-level id must NOT
    // guess a member — an arbitrary (possibly huge) context window would make
    // compaction fire too late. Ambiguous ⇒ null ⇒ caller uses the safe default.
    expect(lookupModelCapabilities("qwen")).toBeNull();
  });

  it("resolves a bare family id when the family has exactly one member", () => {
    // `grok-build` is a single-member family — unambiguous, so it resolves.
    const caps = lookupModelCapabilities("grok-build");
    expect(caps).not.toBeNull();
    expect(caps!.contextWindow).toBeGreaterThan(0);
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
