import { describe, it, expect } from "vitest";
import { toCodexModel, toOpenAiModel } from "../../lib/openai-model-mapping";

const MAPPED_MODELS = [
  "openai/gpt-4o",
  "openai/gpt-4o-mini",
  "openai/o1",
  "openai/o1-mini",
  "openai/o3-mini",
  "openai/o4-mini",
];

describe("toCodexModel", () => {
  it("converts openai/* to openai-codex/* for all mapped models", () => {
    expect(toCodexModel("openai/gpt-4o")).toBe("openai-codex/gpt-4o");
    expect(toCodexModel("openai/gpt-4o-mini")).toBe("openai-codex/gpt-4o-mini");
    expect(toCodexModel("openai/o1")).toBe("openai-codex/o1");
    expect(toCodexModel("openai/o1-mini")).toBe("openai-codex/o1-mini");
    expect(toCodexModel("openai/o3-mini")).toBe("openai-codex/o3-mini");
    expect(toCodexModel("openai/o4-mini")).toBe("openai-codex/o4-mini");
  });

  it("returns null for unmapped openai model", () => {
    expect(toCodexModel("openai/unmapped-model")).toBeNull();
  });

  it("returns null for wrong prefix (anthropic)", () => {
    expect(toCodexModel("anthropic/claude-3")).toBeNull();
  });
});

describe("toOpenAiModel", () => {
  it("converts openai-codex/* to openai/* for all mapped models", () => {
    expect(toOpenAiModel("openai-codex/gpt-4o")).toBe("openai/gpt-4o");
    expect(toOpenAiModel("openai-codex/gpt-4o-mini")).toBe("openai/gpt-4o-mini");
    expect(toOpenAiModel("openai-codex/o1")).toBe("openai/o1");
    expect(toOpenAiModel("openai-codex/o1-mini")).toBe("openai/o1-mini");
    expect(toOpenAiModel("openai-codex/o3-mini")).toBe("openai/o3-mini");
    expect(toOpenAiModel("openai-codex/o4-mini")).toBe("openai/o4-mini");
  });

  it("returns null for unmapped openai-codex model", () => {
    expect(toOpenAiModel("openai-codex/unmapped")).toBeNull();
  });

  it("returns null for wrong prefix (openai/ instead of openai-codex/)", () => {
    expect(toOpenAiModel("openai/gpt-4o")).toBeNull();
  });
});

describe("round-trip invariant", () => {
  it("toOpenAiModel(toCodexModel(model)) === model for every mapped model", () => {
    for (const model of MAPPED_MODELS) {
      const codex = toCodexModel(model);
      expect(codex).not.toBeNull();
      expect(toOpenAiModel(codex!)).toBe(model);
    }
  });
});
