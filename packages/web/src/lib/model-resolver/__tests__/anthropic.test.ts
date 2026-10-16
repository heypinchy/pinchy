import { describe, expect, it } from "vitest";
import { resolveAnthropic } from "../providers/anthropic";

describe("resolveAnthropic", () => {
  it("maps tier=fast to haiku 5.5", () => {
    const r = resolveAnthropic({ tier: "fast" });
    expect(r.model).toBe("anthropic/claude-haiku-5-5");
    expect(r.fallbackUsed).toBe(false);
  });

  it("maps tier=balanced to sonnet 5.5", () => {
    const r = resolveAnthropic({ tier: "balanced" });
    expect(r.model).toBe("anthropic/claude-sonnet-5-5");
  });

  // Fable 5.1 ($10/$50) stays opt-in: it is 2.5× Opus 5.5 per token, and a
  // template's tier is a default nobody chose deliberately.
  it("maps tier=reasoning to opus 5.5, not the Fable tier", () => {
    const r = resolveAnthropic({ tier: "reasoning" });
    expect(r.model).toBe("anthropic/claude-opus-5-5");
  });

  it("ignores taskType — cloud providers cover all tasks within a tier", () => {
    const a = resolveAnthropic({ tier: "balanced", taskType: "coder" });
    const b = resolveAnthropic({ tier: "balanced", taskType: "general" });
    expect(a.model).toBe(b.model);
  });

  it("capabilities: vision + long-context + tools are satisfied by all tiers", () => {
    const r = resolveAnthropic({
      tier: "fast",
      capabilities: ["vision", "long-context", "tools"],
    });
    expect(r.model).toBeDefined();
  });

  it("includes human-readable reason", () => {
    const r = resolveAnthropic({ tier: "reasoning" });
    expect(r.reason).toContain("reasoning");
  });
});
