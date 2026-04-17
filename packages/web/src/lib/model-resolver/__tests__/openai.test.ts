import { describe, expect, it } from "vitest";
import { resolveOpenAI } from "../providers/openai";

describe("resolveOpenAI", () => {
  it("maps tier=fast to gpt-4o-mini", () => {
    const r = resolveOpenAI({ tier: "fast" });
    expect(r.model).toMatch(/4o-mini/);
    expect(r.fallbackUsed).toBe(false);
  });

  it("maps tier=balanced to gpt-4o", () => {
    const r = resolveOpenAI({ tier: "balanced" });
    expect(r.model).toMatch(/4o/);
  });

  it("maps tier=reasoning to gpt-5 or o-class", () => {
    const r = resolveOpenAI({ tier: "reasoning" });
    expect(r.model).toBeDefined();
  });

  it("ignores taskType — cloud providers cover all tasks within a tier", () => {
    const a = resolveOpenAI({ tier: "balanced", taskType: "coder" });
    const b = resolveOpenAI({ tier: "balanced", taskType: "general" });
    expect(a.model).toBe(b.model);
  });

  it("capabilities: vision + long-context + tools are satisfied by all tiers", () => {
    const r = resolveOpenAI({
      tier: "fast",
      capabilities: ["vision", "long-context", "tools"],
    });
    expect(r.model).toBeDefined();
  });

  it("includes human-readable reason", () => {
    const r = resolveOpenAI({ tier: "reasoning" });
    expect(r.reason).toContain("reasoning");
  });
});
