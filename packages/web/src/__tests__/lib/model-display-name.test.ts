import { describe, it, expect } from "vitest";
import { getModelDisplayName } from "@/lib/model-display-name";

describe("getModelDisplayName", () => {
  it("converts claude-sonnet-4-6 version notation correctly", () => {
    expect(getModelDisplayName("anthropic/claude-sonnet-4-6")).toBe("Claude Sonnet 4.6");
  });

  it("converts gpt-5.5 and uppercases GPT", () => {
    expect(getModelDisplayName("openai/gpt-5.5")).toBe("GPT 5.5");
  });

  it("converts gemini-2.5-pro", () => {
    expect(getModelDisplayName("google/gemini-2.5-pro")).toBe("Gemini 2.5 Pro");
  });

  it("strips parameter suffix (:80b) for ollama-cloud models", () => {
    expect(getModelDisplayName("ollama-cloud/qwen3-next:80b")).toBe("Qwen3 Next");
  });

  it("handles llama3.2 without breaking dot notation", () => {
    expect(getModelDisplayName("ollama/llama3.2")).toBe("Llama3.2");
  });
});
