import { describe, it, expect } from "vitest";
import { isModelVisionCapable } from "@/lib/model-vision";

describe("isModelVisionCapable", () => {
  describe("full-vision providers (all models capable)", () => {
    it("should return true for any Anthropic model", () => {
      expect(isModelVisionCapable("anthropic/claude-haiku-4-5-20251001")).toBe(true);
      expect(isModelVisionCapable("anthropic/claude-opus-4-6")).toBe(true);
    });

    it("should return true for any OpenAI model", () => {
      expect(isModelVisionCapable("openai/gpt-4o")).toBe(true);
      expect(isModelVisionCapable("openai/gpt-4o-mini")).toBe(true);
    });

    it("should return true for any Google model", () => {
      expect(isModelVisionCapable("google/gemini-2.5-flash")).toBe(true);
    });
  });

  describe("Ollama local vision models", () => {
    it("should return true for llava models", () => {
      expect(isModelVisionCapable("ollama/llava:latest")).toBe(true);
      expect(isModelVisionCapable("ollama/llava:7b")).toBe(true);
    });

    it("should return true for llama3.2-vision models", () => {
      expect(isModelVisionCapable("ollama/llama3.2-vision:11b")).toBe(true);
    });

    it("should return true for qwen2-vl models", () => {
      expect(isModelVisionCapable("ollama/qwen2-vl:7b")).toBe(true);
      expect(isModelVisionCapable("ollama/qwen2.5-vl:7b")).toBe(true);
    });

    it("should return false for non-vision Ollama models", () => {
      expect(isModelVisionCapable("ollama/llama3.2:3b")).toBe(false);
      expect(isModelVisionCapable("ollama/mistral:7b")).toBe(false);
    });
  });

  describe("Ollama cloud vision models", () => {
    it("should return true for qwen3.5 cloud (multimodal)", () => {
      expect(isModelVisionCapable("ollama-cloud/qwen3.5:397b-cloud")).toBe(true);
    });

    it("should return true for kimi-k2.5 cloud (native multimodal)", () => {
      expect(isModelVisionCapable("ollama-cloud/kimi-k2.5:cloud")).toBe(true);
    });

    it("should return true for gemini-3-flash-preview cloud", () => {
      expect(isModelVisionCapable("ollama-cloud/gemini-3-flash-preview:cloud")).toBe(true);
    });

    it("should return true for mistral-large-3 cloud (multimodal MoE)", () => {
      expect(isModelVisionCapable("ollama-cloud/mistral-large-3:675b-cloud")).toBe(true);
    });

    it("should return true for ministral-3 cloud", () => {
      expect(isModelVisionCapable("ollama-cloud/ministral-3:14b-cloud")).toBe(true);
    });

    it("should return true for qwen3-vl cloud (vision-language)", () => {
      expect(isModelVisionCapable("ollama-cloud/qwen3-vl:235b-cloud")).toBe(true);
      expect(isModelVisionCapable("ollama-cloud/qwen3-vl:235b-instruct-cloud")).toBe(true);
    });

    it("should return true for gemma3 cloud (multimodal)", () => {
      expect(isModelVisionCapable("ollama-cloud/gemma3:4b-cloud")).toBe(true);
      expect(isModelVisionCapable("ollama-cloud/gemma3:12b-cloud")).toBe(true);
      expect(isModelVisionCapable("ollama-cloud/gemma3:27b-cloud")).toBe(true);
    });

    it("should return false for non-vision Ollama cloud models", () => {
      expect(isModelVisionCapable("ollama-cloud/deepseek-v3.2:cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/glm-4.7:cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/glm-5:cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/gpt-oss:120b-cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/minimax-m2.5:cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/minimax-m2.7:cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/nemotron-3-nano:30b-cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/nemotron-3-super:cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/qwen3-coder-next:cloud")).toBe(false);
      expect(isModelVisionCapable("ollama-cloud/qwen3-next:80b-cloud")).toBe(false);
    });
  });

  describe("unknown providers", () => {
    it("should return false for unknown providers", () => {
      expect(isModelVisionCapable("unknown/some-model")).toBe(false);
      expect(isModelVisionCapable("somemodel")).toBe(false);
    });
  });
});
