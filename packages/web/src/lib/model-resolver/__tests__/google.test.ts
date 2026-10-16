import { describe, expect, it } from "vitest";
import { resolveGoogle } from "../providers/google";

describe("resolveGoogle", () => {
  it("maps tier=fast to gemini-3.5-flash-lite (Google's fastest stable)", () => {
    const r = resolveGoogle({ tier: "fast" });
    expect(r.model).toBe("google/gemini-3.5-flash-lite");
    expect(r.fallbackUsed).toBe(false);
  });

  // Gemini 2.5 is "access limited to users who used it previously" on the
  // Gemini API, so a new install could not reach the old balanced pick at all.
  it("maps tier=balanced to gemini-3.8-flash (Google's balanced stable, matches BALANCED_ANCHORS)", () => {
    const r = resolveGoogle({ tier: "balanced" });
    expect(r.model).toBe("google/gemini-3.8-flash");
  });

  it("maps tier=reasoning to gemini-4-argon (Google's most-advanced stable)", () => {
    const r = resolveGoogle({ tier: "reasoning" });
    expect(r.model).toBe("google/gemini-4-argon");
  });

  it("ignores taskType — cloud providers cover all tasks within a tier", () => {
    const a = resolveGoogle({ tier: "balanced", taskType: "coder" });
    const b = resolveGoogle({ tier: "balanced", taskType: "general" });
    expect(a.model).toBe(b.model);
  });

  it("capabilities: vision + long-context + tools are satisfied by all tiers", () => {
    const r = resolveGoogle({
      tier: "fast",
      capabilities: ["vision", "long-context", "tools"],
    });
    expect(r.model).toBeDefined();
  });

  it("includes human-readable reason", () => {
    const r = resolveGoogle({ tier: "reasoning" });
    expect(r.reason).toContain("reasoning");
  });
});
