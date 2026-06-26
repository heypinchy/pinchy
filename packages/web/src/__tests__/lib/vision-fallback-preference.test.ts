import { describe, expect, it } from "vitest";
import { compareVisionFallbackPreference } from "@/lib/openclaw-config/default-media-models";

function sortedIds(candidates: { provider: string; modelId: string }[]): string[] {
  return [...candidates]
    .sort(compareVisionFallbackPreference)
    .map((c) => `${c.provider}/${c.modelId}`);
}

describe("compareVisionFallbackPreference", () => {
  it("orders curated ollama-cloud vision models by quality (OLLAMA_CLOUD_IMAGE_PREFERENCE), not alphabetically", () => {
    // "gemma4:31b" sorts before "minimax-m3" alphabetically, but minimax-m3 is
    // the higher-quality vision model and ranks ahead of it in the curated list.
    const sorted = sortedIds([
      { provider: "ollama-cloud", modelId: "gemma4:31b" },
      { provider: "ollama-cloud", modelId: "minimax-m3" },
    ]);
    expect(sorted).toEqual(["ollama-cloud/minimax-m3", "ollama-cloud/gemma4:31b"]);
  });

  it("ranks a curated vision model ahead of an uncurated one on the same provider", () => {
    const sorted = sortedIds([
      { provider: "ollama-cloud", modelId: "kimi-k2.5" }, // not in the curated list
      { provider: "ollama-cloud", modelId: "minimax-m3" }, // curated
    ]);
    expect(sorted[0]).toBe("ollama-cloud/minimax-m3");
  });

  it("breaks ties between two uncurated same-provider models alphabetically for determinism", () => {
    const sorted = sortedIds([
      { provider: "ollama-cloud", modelId: "ministral-3:14b" },
      { provider: "ollama-cloud", modelId: "kimi-k2.5" },
    ]);
    expect(sorted).toEqual(["ollama-cloud/kimi-k2.5", "ollama-cloud/ministral-3:14b"]);
  });

  it("prefers a native-vision provider over ollama-cloud", () => {
    const sorted = sortedIds([
      { provider: "ollama-cloud", modelId: "minimax-m3" },
      { provider: "anthropic", modelId: "claude-opus-4" },
    ]);
    expect(sorted[0]).toBe("anthropic/claude-opus-4");
  });

  it("breaks ties between two models on the same native provider alphabetically", () => {
    // Native providers carry no curated intra-provider order, so two models on
    // the same provider fall through to the deterministic alphabetical tiebreak.
    const sorted = sortedIds([
      { provider: "anthropic", modelId: "claude-opus-4" },
      { provider: "anthropic", modelId: "claude-haiku-4" },
    ]);
    expect(sorted).toEqual(["anthropic/claude-haiku-4", "anthropic/claude-opus-4"]);
  });

  it("ranks a provider absent from the preference list (e.g. ollama-local) behind the listed providers", () => {
    // ollama-local isn't in IMAGE_MODEL_PREFERENCE, so its vision models sort
    // after every listed provider — including ollama-cloud — in the global
    // order the resolver uses for its cross-provider last resort.
    const sorted = sortedIds([
      { provider: "ollama-local", modelId: "llama3.2-vision" },
      { provider: "ollama-cloud", modelId: "minimax-m3" },
    ]);
    expect(sorted).toEqual(["ollama-cloud/minimax-m3", "ollama-local/llama3.2-vision"]);
  });
});
