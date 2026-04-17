import { describe, expect, it } from "vitest";
import { resolveGoogle } from "../providers/google";

describe("resolveGoogle", () => {
  it("maps tier=fast to gemini flash variant", () => {
    const r = resolveGoogle({ tier: "fast" });
    expect(r.model).toMatch(/flash/i);
    expect(r.fallbackUsed).toBe(false);
  });

  it("maps tier=balanced to gemini pro variant", () => {
    const r = resolveGoogle({ tier: "balanced" });
    expect(r.model).toMatch(/pro/i);
  });

  it("maps tier=reasoning to gemini ultra or thinking variant", () => {
    const r = resolveGoogle({ tier: "reasoning" });
    expect(r.model).toBeDefined();
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
