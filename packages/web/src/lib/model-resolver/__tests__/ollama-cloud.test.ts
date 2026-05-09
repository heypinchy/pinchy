import { describe, expect, it } from "vitest";
import { TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS } from "@/lib/ollama-cloud-models";
import { resolveOllamaCloud } from "../providers/ollama-cloud";

describe("resolveOllamaCloud", () => {
  it("picks a flash model for tier=fast", () => {
    const r = resolveOllamaCloud({ tier: "fast" });
    expect(r.model).toMatch(/flash/i);
  });

  it("picks a larger model for tier=reasoning", () => {
    const r = resolveOllamaCloud({ tier: "reasoning" });
    expect(r.model).toBeDefined();
    expect(r.reason).toContain("reasoning");
  });

  it("prefers a coder model when taskType=coder", () => {
    const r = resolveOllamaCloud({ tier: "balanced", taskType: "coder" });
    expect(r.model).toMatch(/coder/i);
  });

  it("falls back to general when taskType has no dedicated map entry", () => {
    const r = resolveOllamaCloud({ tier: "fast", taskType: "reasoning" });
    expect(r.model).toBeDefined();
    expect(r.fallbackUsed).toBe(true);
  });

  it("returns fallbackUsed=false when exact taskType match exists", () => {
    const r = resolveOllamaCloud({ tier: "balanced", taskType: "coder" });
    expect(r.fallbackUsed).toBe(false);
  });
});

describe("resolveOllamaCloud — allowlist invariant", () => {
  it("every resolver target is present in TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS", () => {
    const allowlist = new Set<string>(TOOL_CAPABLE_OLLAMA_CLOUD_MODEL_IDS);
    const tiers = ["fast", "balanced", "reasoning"] as const;
    const taskTypes = ["general", "coder", "vision", "reasoning"] as const;
    for (const tier of tiers) {
      for (const taskType of taskTypes) {
        const { model } = resolveOllamaCloud({ tier, taskType });
        const bareId = model.replace(/^ollama-cloud\//, "");
        expect(allowlist.has(bareId)).toBe(true);
      }
    }
  });
});

describe("resolveOllamaCloud — reasoning tier", () => {
  it("falls through to deepseek-v4-pro when taskType=reasoning (kimi-k2-thinking removed in #305)", () => {
    const result = resolveOllamaCloud({ tier: "reasoning", taskType: "reasoning" });
    expect(result.model).toBe("ollama-cloud/deepseek-v4-pro");
    expect(result.fallbackUsed).toBe(true);
  });

  it("keeps deepseek-v4-pro for tier=reasoning, taskType=general", () => {
    const result = resolveOllamaCloud({ tier: "reasoning", taskType: "general" });
    expect(result.model).toBe("ollama-cloud/deepseek-v4-pro");
    expect(result.fallbackUsed).toBe(false);
  });
});
