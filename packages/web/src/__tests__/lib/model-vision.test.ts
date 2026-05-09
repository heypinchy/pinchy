import { describe, it, expect, beforeEach } from "vitest";
import { isModelVisionCapable, setOllamaLocalVisionModels } from "@/lib/model-vision";

describe("isModelVisionCapable", () => {
  describe("full-vision providers (all models capable)", () => {
    it("should return true for any Anthropic model", () => {
      expect(isModelVisionCapable("anthropic/claude-haiku-4-5-20251001")).toBe(true);
    });

    it("should return true for any OpenAI model", () => {
      expect(isModelVisionCapable("openai/gpt-5.4-mini")).toBe(true);
    });

    it("should return true for any Google model", () => {
      expect(isModelVisionCapable("google/gemini-2.5-flash")).toBe(true);
    });
  });

  describe("Ollama local vision models", () => {
    it("should return true for llava models", () => {
      expect(isModelVisionCapable("ollama/llava:7b")).toBe(true);
    });

    it("should return false for non-vision Ollama models", () => {
      expect(isModelVisionCapable("ollama/llama3.2:3b")).toBe(false);
    });
  });

  describe("Ollama cloud vision models", () => {
    // Cloud vision IDs come from ollama-cloud-models.ts (tool-capable
    // allowlist filtered by `vision: true`). Exact-match — no prefix-match
    // — so `qwen3.5:397b` must be spelled out, not `qwen3.5`.
    it("should return true for kimi-k2.5", () => {
      expect(isModelVisionCapable("ollama-cloud/kimi-k2.5")).toBe(true);
    });

    it("should return true for gemini-3-flash-preview", () => {
      expect(isModelVisionCapable("ollama-cloud/gemini-3-flash-preview")).toBe(true);
    });

    it("should return true for mistral-large-3:675b", () => {
      expect(isModelVisionCapable("ollama-cloud/mistral-large-3:675b")).toBe(true);
    });

    it("should return true for qwen3.5:397b", () => {
      expect(isModelVisionCapable("ollama-cloud/qwen3.5:397b")).toBe(true);
    });

    it("should return true for every ministral-3 variant", () => {
      expect(isModelVisionCapable("ollama-cloud/ministral-3:3b")).toBe(true);
      expect(isModelVisionCapable("ollama-cloud/ministral-3:8b")).toBe(true);
      expect(isModelVisionCapable("ollama-cloud/ministral-3:14b")).toBe(true);
    });

    it("should return true for both qwen3-vl variants", () => {
      expect(isModelVisionCapable("ollama-cloud/qwen3-vl:235b")).toBe(true);
      expect(isModelVisionCapable("ollama-cloud/qwen3-vl:235b-instruct")).toBe(true);
    });

    it("should return true for gemma4:31b", () => {
      // Regression guard for a review finding: gemma4 is vision-capable per
      // ollama.com/library/gemma4 but was missing from the hardcoded list.
      expect(isModelVisionCapable("ollama-cloud/gemma4:31b")).toBe(true);
    });

    it("should return true for devstral-small-2:24b", () => {
      // Devstral Small 2's library page lists "Text, Image" input type.
      expect(isModelVisionCapable("ollama-cloud/devstral-small-2:24b")).toBe(true);
    });

    it("should return false for tool-capable cloud models that are text-only", () => {
      expect(isModelVisionCapable("ollama-cloud/deepseek-v3.2")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/glm-4.7")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/nemotron-3-nano:30b")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/gpt-oss:20b")).toBe(false);
      // kimi-k2-thinking removed from allowlist (#305) — vision check is moot
      expect(isModelVisionCapable("ollama-cloud/qwen3-coder:480b")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/qwen3-coder-next")).toBe(false);
    });

    it("should return false for models Pinchy doesn't surface (not in the tool-capable allowlist)", () => {
      // gemma3 is vision-capable locally but not tool-capable on Ollama
      // Cloud, so Pinchy filters it out and never shows it in the cloud
      // model picker. It must not be reported as vision-capable under the
      // ollama-cloud provider either.
      expect(isModelVisionCapable("ollama-cloud/gemma3:27b")).toBe(false);
    });
  });

  describe("Ollama local vision detection with capabilities cache", () => {
    beforeEach(() => {
      // Reset cache before each test
      setOllamaLocalVisionModels(null);
    });

    it("should use capabilities cache for local ollama models when available", () => {
      setOllamaLocalVisionModels(new Set(["llama3.2-vision:latest", "custom-vision:7b"]));

      expect(isModelVisionCapable("ollama/custom-vision:7b")).toBe(true);
      expect(isModelVisionCapable("ollama/llama3:latest")).toBe(false);
      // llava would be true with hardcoded list, but cache overrides
      expect(isModelVisionCapable("ollama/llava:7b")).toBe(false);
    });

    it("should fall back to hardcoded list when no capabilities cached", () => {
      setOllamaLocalVisionModels(null);

      // llava is in the hardcoded list
      expect(isModelVisionCapable("ollama/llava:7b")).toBe(true);
      // unknown model — not in hardcoded list
      expect(isModelVisionCapable("ollama/custom-vision:7b")).toBe(false);
    });
  });

  describe("unknown providers", () => {
    it("should return false for unknown providers", () => {
      expect(isModelVisionCapable("unknown/some-model")).toBe(false);
    });
  });
});
