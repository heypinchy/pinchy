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

  it("returns true for mistral-large-3:675b", () => {
    expect(isModelVisionCapable("ollama-cloud/mistral-large-3:675b")).toBe(true);
  });

  it("returns true for minimax-m3", () => {
    expect(isModelVisionCapable("ollama-cloud/minimax-m3")).toBe(true);
  });

  it("returns true for qwen3.5:397b since the 2026-07-30 re-probe", () => {
    // This asserted FALSE until 2026-07-30, because the live endpoint used to
    // accept images and hallucinate their contents — worse than a rejection,
    // since it looks like a working answer. A 2026-07-30 re-probe with 512x512
    // fixtures read the number and colour correctly in 6/6 trials, so the
    // catalog flag flipped and so does this expectation.
    expect(isModelVisionCapable("ollama-cloud/qwen3.5:397b")).toBe(true);
  });

  it("returns true for kimi-k2.7-code since the 2026-07-30 re-probe", () => {
    // Also FALSE until 2026-07-30, for a different reason: the live endpoint
    // HTTP 500'd on every image_url payload (probed 2026-06-25). It reads the
    // 512x512 fixture correctly in 6/6 trials now. Part of the same flip is a
    // fixture fix — the old 64x64 probe image is refused outright by Ollama's
    // decoders today, and this model still 500s on it.
    expect(isModelVisionCapable("ollama-cloud/kimi-k2.7-code")).toBe(true);
  });

  it("returns true for kimi-k2.6", () => {
    // Replaces the old qwen3-vl:235b(-instruct) block — Ollama dropped both
    // from the cloud catalog (2026-06-17). kimi-k2.5 / minimax-m3 /
    // mistral-large-3 already have their own dedicated cases above; kimi-k2.6
    // was the one vision model still lacking one.
    expect(isModelVisionCapable("ollama-cloud/kimi-k2.6")).toBe(true);
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
    // Dropped from the catalog on 2026-07-30 for skipping tool calls, so this
    // now also covers the "model we no longer carry" path — same answer either
    // way, which is the point: nothing removed may come back vision-capable.
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
