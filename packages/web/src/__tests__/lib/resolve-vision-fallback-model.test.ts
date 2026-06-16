import { describe, expect, it } from "vitest";
import { resolveVisionFallbackModel } from "@/lib/image-fallback";

// Candidates are vision-capable models available in the catalog, in preference order.
const QWEN_VL = {
  id: "ollama-cloud/qwen3-vl:235b-instruct",
  provider: "ollama-cloud",
  tools: true,
};
const GEMMA = { id: "ollama-cloud/gemma4:31b", provider: "ollama-cloud", tools: false };
const CLAUDE = { id: "anthropic/claude-opus-4-8", provider: "anthropic", tools: true };

describe("resolveVisionFallbackModel", () => {
  it("prefers a vision model from the SAME provider as the agent — avoids cross-provider history/signature breakage", () => {
    const picked = resolveVisionFallbackModel({
      agentModel: "ollama-cloud/glm-5.1",
      agentUsesTools: false,
      candidates: [CLAUDE, QWEN_VL], // global order would put anthropic first
      globalDefault: "anthropic/claude-opus-4-8",
    });
    expect(picked).toBe("ollama-cloud/qwen3-vl:235b-instruct");
  });

  it("prefers a same-provider vision model that ALSO has tools when the agent uses tools", () => {
    const picked = resolveVisionFallbackModel({
      agentModel: "ollama-cloud/glm-5.1",
      agentUsesTools: true,
      candidates: [GEMMA, QWEN_VL], // gemma (no tools) listed first
      globalDefault: null,
    });
    expect(picked).toBe("ollama-cloud/qwen3-vl:235b-instruct");
  });

  it("falls back to the global default when no same-provider vision model exists", () => {
    const picked = resolveVisionFallbackModel({
      agentModel: "openai/gpt-5.5-text",
      agentUsesTools: false,
      candidates: [QWEN_VL],
      globalDefault: "ollama-cloud/qwen3-vl:235b-instruct",
    });
    expect(picked).toBe("ollama-cloud/qwen3-vl:235b-instruct");
  });

  it("returns null when there is neither a candidate nor a global default", () => {
    const picked = resolveVisionFallbackModel({
      agentModel: "openai/gpt-5.5-text",
      agentUsesTools: false,
      candidates: [],
      globalDefault: null,
    });
    expect(picked).toBeNull();
  });
});
