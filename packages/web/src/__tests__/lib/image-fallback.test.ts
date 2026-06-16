import { describe, expect, it } from "vitest";
import { decideTurnModel } from "@/lib/image-fallback";

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
