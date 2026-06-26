import { describe, expect, it } from "vitest";
import { decideTurnModel, resolveVisionFallbackModel } from "@/lib/image-fallback";

describe("decideTurnModel", () => {
  it("uses the agent's own model when the turn needs no vision — no image, no swap", () => {
    const decision = decideTurnModel({
      turnNeedsVision: false,
      agentModelSupportsVision: false,
      visionFallbackModel: "ollama-cloud/qwen3-vl:235b-instruct",
    });
    expect(decision).toEqual({ kind: "agent-model" });
  });

  it("uses the agent's own model when it is already vision-capable — image goes inline, no swap", () => {
    const decision = decideTurnModel({
      turnNeedsVision: true,
      agentModelSupportsVision: true,
      visionFallbackModel: "ollama-cloud/qwen3-vl:235b-instruct",
    });
    expect(decision).toEqual({ kind: "agent-model" });
  });

  it("routes the turn to the vision fallback when the agent model is text-only and a fallback exists", () => {
    const decision = decideTurnModel({
      turnNeedsVision: true,
      agentModelSupportsVision: false,
      visionFallbackModel: "ollama-cloud/qwen3-vl:235b-instruct",
    });
    expect(decision).toEqual({ kind: "fallback", model: "ollama-cloud/qwen3-vl:235b-instruct" });
  });

  it("blocks when the agent model is text-only and NO vision fallback is configured — recovery case", () => {
    const decision = decideTurnModel({
      turnNeedsVision: true,
      agentModelSupportsVision: false,
      visionFallbackModel: null,
    });
    expect(decision).toEqual({ kind: "blocked" });
  });
});

describe("resolveVisionFallbackModel", () => {
  const PREVIEW = {
    id: "ollama-cloud/gemini-3-flash-preview",
    provider: "ollama-cloud",
    tools: true,
  };
  const MINIMAX = { id: "ollama-cloud/minimax-m3", provider: "ollama-cloud", tools: true };

  it("skips a tools-blocked preview model when the agent uses tools and picks the next usable same-provider candidate", () => {
    // The whole bug: gemini-3-flash-preview is seeded tools:true but is on the
    // tools blocklist (-preview drops thought_signature → upstream 400). A
    // tool-using agent (e.g. Piper with Odoo tools) must never be routed to it.
    const model = resolveVisionFallbackModel({
      agentModel: "ollama-cloud/glm-5.2",
      agentUsesTools: true,
      candidates: [PREVIEW, MINIMAX],
      globalDefault: null,
    });
    expect(model).toBe("ollama-cloud/minimax-m3");
  });

  it("still allows a preview model when the agent does NOT use tools — preview is fine for pure image description", () => {
    const model = resolveVisionFallbackModel({
      agentModel: "ollama-cloud/glm-5.2",
      agentUsesTools: false,
      candidates: [PREVIEW, MINIMAX],
      globalDefault: null,
    });
    expect(model).toBe("ollama-cloud/gemini-3-flash-preview");
  });

  it("does not fall back to a tools-blocked global default for a tool-using agent — blocks instead of shipping a 400", () => {
    const model = resolveVisionFallbackModel({
      agentModel: "ollama-cloud/glm-5.2",
      agentUsesTools: true,
      candidates: [],
      globalDefault: "ollama-cloud/gemini-3-flash-preview",
    });
    expect(model).toBeNull();
  });

  it("uses a tools-blocked global default when the agent does NOT use tools", () => {
    const model = resolveVisionFallbackModel({
      agentModel: "ollama-cloud/glm-5.2",
      agentUsesTools: false,
      candidates: [],
      globalDefault: "ollama-cloud/gemini-3-flash-preview",
    });
    expect(model).toBe("ollama-cloud/gemini-3-flash-preview");
  });
});
