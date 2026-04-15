import { describe, it, expect, beforeEach } from "vitest";
import { isModelVisionCapable, setOllamaLocalVisionModels } from "@/lib/model-vision";

describe("isModelVisionCapable", () => {
  describe("full-vision providers (all models capable)", () => {
    it("should return true for any Anthropic model", () => {
      expect(isModelVisionCapable("anthropic/claude-haiku-4-5-20251001")).toBe(true);
    });

    it("should return true for any OpenAI model", () => {
      expect(isModelVisionCapable("openai/gpt-4o-mini")).toBe(true);
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
    // Cloud model IDs are the bare names returned by https://ollama.com/v1/models
    // — no ":cloud" / "-cloud" suffix since Ollama dropped them.
    it("should return true for kimi-k2.5", () => {
      expect(isModelVisionCapable("ollama-cloud/kimi-k2.5")).toBe(true);
    });

    it("should return true for gemini-3-flash-preview", () => {
      expect(isModelVisionCapable("ollama-cloud/gemini-3-flash-preview")).toBe(true);
    });

    it("should return true for mistral-large-3", () => {
      expect(isModelVisionCapable("ollama-cloud/mistral-large-3:675b")).toBe(true);
    });

    it("should return true for qwen3.5", () => {
      expect(isModelVisionCapable("ollama-cloud/qwen3.5:397b")).toBe(true);
    });

    it("should return true for ministral-3", () => {
      expect(isModelVisionCapable("ollama-cloud/ministral-3:14b")).toBe(true);
    });

    it("should return true for qwen3-vl", () => {
      expect(isModelVisionCapable("ollama-cloud/qwen3-vl:235b")).toBe(true);
    });

    it("should return true for gemma3", () => {
      expect(isModelVisionCapable("ollama-cloud/gemma3:27b")).toBe(true);
    });

    it("should return false for non-vision Ollama cloud models", () => {
      expect(isModelVisionCapable("ollama-cloud/deepseek-v3.2")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/glm-4.7")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/nemotron-3-nano:30b")).toBe(false);
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
