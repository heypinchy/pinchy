import { describe, expect, it } from "vitest";
import { resolveOpenAI } from "../providers/openai";

describe("resolveOpenAI", () => {
  it("maps tier=fast to gpt-6-luna", () => {
    const r = resolveOpenAI({ tier: "fast" });
    expect(r.model).toBe("openai/gpt-6-luna");
    expect(r.fallbackUsed).toBe(false);
  });

  it("maps tier=balanced to gpt-6.1-sol (matches BALANCED_ANCHORS)", () => {
    const r = resolveOpenAI({ tier: "balanced" });
    expect(r.model).toBe("openai/gpt-6.1-sol");
  });

  // GPT-6 Astra ($10/$50) is the Fable-priced tier and stays opt-in, as it does
  // for Anthropic; Sol is OpenAI's "near-Astra at a lower cost" model.
  it("maps tier=reasoning to gpt-6.1-sol, not the Astra tier", () => {
    const r = resolveOpenAI({ tier: "reasoning" });
    expect(r.model).toBe("openai/gpt-6.1-sol");
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
