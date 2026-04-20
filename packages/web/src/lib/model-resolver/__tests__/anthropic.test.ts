import { describe, expect, it } from "vitest";
import { resolveAnthropic } from "../providers/anthropic";

describe("resolveAnthropic", () => {
  it("maps tier=fast to haiku", () => {
    const r = resolveAnthropic({ tier: "fast" });
    expect(r.model).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(r.fallbackUsed).toBe(false);
  });

  it("maps tier=balanced to sonnet", () => {
    const r = resolveAnthropic({ tier: "balanced" });
    expect(r.model).toMatch(/sonnet/);
  });

  it("maps tier=reasoning to opus", () => {
    const r = resolveAnthropic({ tier: "reasoning" });
    expect(r.model).toMatch(/opus/);
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
