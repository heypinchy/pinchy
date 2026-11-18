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

  it("resolves a full canonical snapshot key but keeps the discovered id verbatim", () => {
    // Exercises the exact-match branch. The catalog only ENRICHES capabilities —
    // it must NOT rewrite the id. The id is whatever the endpoint's `/models`
    // advertised, and OpenClaw sends exactly that string back as the `model`
    // field at chat time (it splits only the provider slug off `<slug>/<id>`).
    // De-prefixing here would send `mistral-large-2512` to a passthrough gateway
    // (LiteLLM/OpenRouter) that advertised — and only accepts — the namespaced
    // `mistral/mistral-large-2512`, producing a "model not found" at chat time.
    const caps = lookupModelCapabilities("mistral/mistral-large-2512");
    expect(caps).not.toBeNull();
    expect(caps!.id).toBe("mistral/mistral-large-2512");
    // Real snapshot capabilities, not the fallback default — proves it matched.
    expect(caps!.contextWindow).not.toBe(DEFAULT_MODEL_CAPS.contextWindow);
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

  it("does not resolve Object.prototype keys from an untrusted discovered id", () => {
    // `modelId` comes from a third-party /v1/models response. A plain-object
    // catalog lookup like `CATALOG[modelId]` would return an inherited function
    // (truthy) for prototype keys, producing a malformed definition instead of
    // falling through to null. Must be prototype-safe.
    expect(lookupModelCapabilities("constructor")).toBeNull();
    expect(lookupModelCapabilities("toString")).toBeNull();
    expect(lookupModelCapabilities("hasOwnProperty")).toBeNull();
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
