import { isModelVisionCapable, setOllamaLocalVisionModels } from "@/lib/model-vision";
import {
  loadModelCapabilityCache,
  invalidateModelCapabilityCache,
} from "@/lib/model-capabilities/cache";
import { db } from "@/db";
import { models } from "@/db/schema";
import { seedBuiltinModels } from "@/lib/model-capabilities/seed";
import { beforeEach, it, expect, describe } from "vitest";

beforeEach(async () => {
  await db.delete(models);
  await seedBuiltinModels();
  invalidateModelCapabilityCache();
  await loadModelCapabilityCache();
});

describe("full-vision providers (all models in DB)", () => {
  it("returns true for an anthropic vision model", () => {
    expect(isModelVisionCapable("anthropic/claude-opus-4-7")).toBe(true);
  });

  it("returns true for any Anthropic model", () => {
    expect(isModelVisionCapable("anthropic/claude-haiku-4-5-20251001")).toBe(true);
  });

  it("returns true for any OpenAI model", () => {
    expect(isModelVisionCapable("openai/gpt-5.4-mini")).toBe(true);
  });

  it("returns true for any Google model", () => {
    expect(isModelVisionCapable("google/gemini-2.5-flash")).toBe(true);
  });

  it("returns false for a known-provider model NOT in the DB (not treated as vision by default)", () => {
    // The old hardcoded implementation would return true for any anthropic model.
    // The cache-backed implementation must return false for models not in the DB.
    expect(isModelVisionCapable("anthropic/claude-text-only-hypothetical")).toBe(false);
  });
});

describe("Ollama cloud vision models (from DB seed)", () => {
  it("returns true for kimi-k2.5", () => {
    expect(isModelVisionCapable("ollama-cloud/kimi-k2.5")).toBe(true);
  });

  it("returns true for gemini-3-flash-preview", () => {
    expect(isModelVisionCapable("ollama-cloud/gemini-3-flash-preview")).toBe(true);
  });

  it("returns true for mistral-large-3:675b", () => {
    expect(isModelVisionCapable("ollama-cloud/mistral-large-3:675b")).toBe(true);
  });

  it("returns true for qwen3.5:397b", () => {
    expect(isModelVisionCapable("ollama-cloud/qwen3.5:397b")).toBe(true);
  });

  it("returns true for every ministral-3 variant", () => {
    expect(isModelVisionCapable("ollama-cloud/ministral-3:3b")).toBe(true);
    expect(isModelVisionCapable("ollama-cloud/ministral-3:8b")).toBe(true);
    expect(isModelVisionCapable("ollama-cloud/ministral-3:14b")).toBe(true);
  });

  it("returns true for both qwen3-vl variants", () => {
    expect(isModelVisionCapable("ollama-cloud/qwen3-vl:235b")).toBe(true);
    expect(isModelVisionCapable("ollama-cloud/qwen3-vl:235b-instruct")).toBe(true);
  });

  it("returns true for gemma4:31b", () => {
    // Regression guard for a review finding: gemma4 is vision-capable per
    // ollama.com/library/gemma4 but was missing from the hardcoded list.
    expect(isModelVisionCapable("ollama-cloud/gemma4:31b")).toBe(true);
  });

  it("returns false for devstral-small-2:24b", () => {
    // Devstral Small 2's library page lists "Text, Image" but the live
    // `/v1/chat/completions` endpoint returns HTTP 400 on image_url payloads
    // (confirmed by empirical API smoke test in #416). It's Mistral's coding
    // series, not a vision model — the library page is misleading.
    expect(isModelVisionCapable("ollama-cloud/devstral-small-2:24b")).toBe(false);
  });

  it("returns false for a model without vision (e.g. deepseek-v4-pro)", () => {
    expect(isModelVisionCapable("ollama-cloud/deepseek-v4-pro")).toBe(false);
  });

  it("returns false for tool-capable cloud models that are text-only", () => {
    expect(isModelVisionCapable("ollama-cloud/deepseek-v3.2")).toBe(false);
    expect(isModelVisionCapable("ollama-cloud/glm-4.7")).toBe(false);
    expect(isModelVisionCapable("ollama-cloud/nemotron-3-nano:30b")).toBe(false);
    expect(isModelVisionCapable("ollama-cloud/gpt-oss:20b")).toBe(false);
    expect(isModelVisionCapable("ollama-cloud/qwen3-coder:480b")).toBe(false);
    expect(isModelVisionCapable("ollama-cloud/qwen3-coder-next")).toBe(false);
  });

  it("returns false for models Pinchy doesn't surface (not in the tool-capable allowlist)", () => {
    // gemma3 is vision-capable locally but not tool-capable on Ollama Cloud,
    // so Pinchy filters it out and never shows it in the cloud model picker.
    expect(isModelVisionCapable("ollama-cloud/gemma3:27b")).toBe(false);
  });
});

describe("Ollama local vision models (detected, written to DB)", () => {
  it("returns true for a detected vision model after setOllamaLocalVisionModels", async () => {
    await setOllamaLocalVisionModels(new Set(["custom-vision:7b", "llama3.2-vision:latest"]));

    expect(isModelVisionCapable("ollama/custom-vision:7b")).toBe(true);
    expect(isModelVisionCapable("ollama/llama3.2-vision:latest")).toBe(true);
  });

  it("returns false for a non-vision local model", async () => {
    await setOllamaLocalVisionModels(new Set(["llama3.2-vision:latest"]));

    expect(isModelVisionCapable("ollama/llama3:latest")).toBe(false);
  });
});

describe("unknown models and providers", () => {
  it("returns false for an unknown model", () => {
    expect(isModelVisionCapable("provider-x/nonexistent")).toBe(false);
  });

  it("returns false for unknown providers", () => {
    expect(isModelVisionCapable("unknown/some-model")).toBe(false);
  });
});
