import { describe, expect, it, vi } from "vitest";
import { resolveImageTurnModel } from "@/lib/image-fallback";

const QWEN_VL = {
  id: "ollama-cloud/qwen3-vl:235b-instruct",
  provider: "ollama-cloud",
  tools: true,
};

function deps(over: Partial<Parameters<typeof resolveImageTurnModel>[0]["deps"]> = {}) {
  return {
    modelSupportsVision: vi.fn().mockReturnValue(false),
    listVisionCandidates: vi.fn().mockResolvedValue([]),
    getGlobalImageModel: vi.fn().mockReturnValue(null),
    ...over,
  };
}

describe("resolveImageTurnModel", () => {
  it("returns agent-model and does not even look up candidates when no attachment needs vision", async () => {
    const d = deps({ listVisionCandidates: vi.fn().mockResolvedValue([QWEN_VL]) });
    const decision = await resolveImageTurnModel({
      agentModel: "ollama-cloud/glm-5.1",
      agentUsesTools: false,
      attachmentMimeTypes: ["application/pdf", "text/plain"],
      deps: d,
    });
    expect(decision).toEqual({ kind: "agent-model" });
    expect(d.listVisionCandidates).not.toHaveBeenCalled();
  });

  it("returns agent-model when the agent model is already vision-capable — image goes inline", async () => {
    const decision = await resolveImageTurnModel({
      agentModel: "ollama-cloud/qwen3-vl:235b-instruct",
      agentUsesTools: false,
      attachmentMimeTypes: ["image/png"],
      deps: deps({ modelSupportsVision: vi.fn().mockReturnValue(true) }),
    });
    expect(decision).toEqual({ kind: "agent-model" });
  });

  it("routes to a same-provider vision fallback when the agent model is text-only", async () => {
    const decision = await resolveImageTurnModel({
      agentModel: "ollama-cloud/glm-5.1",
      agentUsesTools: false,
      attachmentMimeTypes: ["image/png"],
      deps: deps({ listVisionCandidates: vi.fn().mockResolvedValue([QWEN_VL]) }),
    });
    expect(decision).toEqual({ kind: "fallback", model: "ollama-cloud/qwen3-vl:235b-instruct" });
  });

  it("blocks when an image needs vision, the agent model is text-only, and no vision model is configured anywhere", async () => {
    const decision = await resolveImageTurnModel({
      agentModel: "ollama-cloud/glm-5.1",
      agentUsesTools: false,
      attachmentMimeTypes: ["image/jpeg"],
      deps: deps(),
    });
    expect(decision).toEqual({ kind: "blocked" });
  });
});
