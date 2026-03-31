import { describe, it, expect } from "vitest";
import { isModelVisionCapable } from "@/lib/model-vision";

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
    it("should return true for kimi-k2.5 cloud", () => {
      expect(isModelVisionCapable("ollama-cloud/kimi-k2.5:cloud")).toBe(true);
    });

    it("should return true for gemini-3-flash-preview cloud", () => {
      expect(isModelVisionCapable("ollama-cloud/gemini-3-flash-preview:cloud")).toBe(true);
    });

    it("should return true for mistral-large-3 cloud", () => {
      expect(isModelVisionCapable("ollama-cloud/mistral-large-3:675b-cloud")).toBe(true);
    });

    it("should return true for qwen3.5 cloud", () => {
      expect(isModelVisionCapable("ollama-cloud/qwen3.5:397b-cloud")).toBe(true);
    });

    it("should return true for ministral-3 cloud", () => {
      expect(isModelVisionCapable("ollama-cloud/ministral-3:14b-cloud")).toBe(true);
    });

    it("should return true for qwen3-vl cloud", () => {
      expect(isModelVisionCapable("ollama-cloud/qwen3-vl:235b-cloud")).toBe(true);
    });

    it("should return true for gemma3 cloud", () => {
      expect(isModelVisionCapable("ollama-cloud/gemma3:27b-cloud")).toBe(true);
    });

    it("should return false for non-vision Ollama cloud models", () => {
      expect(isModelVisionCapable("ollama-cloud/deepseek-v3.2:cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/glm-4.7:cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/nemotron-3-nano:30b-cloud")).toBe(false);
    });
  });

  describe("unknown providers", () => {
    it("should return false for unknown providers", () => {
      expect(isModelVisionCapable("unknown/some-model")).toBe(false);
    });
  });
});
