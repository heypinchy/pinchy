import { afterEach, describe, expect, it, vi } from "vitest";

// Mocked I/O deps for the vision-model chain resolvers. The chain builders in
// default-media-models are pure preference logic over these — mock the edges.
const getSetting = vi.fn<(key: string) => Promise<string | null>>();
const getDefaultModel = vi.fn<(provider: string) => Promise<string | null>>();
const fetchProviderModels = vi.fn<() => Promise<{ id: string; models: { id: string }[] }[]>>();
const isModelVisionCapable = vi.fn<(model: string) => boolean>();

vi.mock("@/lib/settings", () => ({ getSetting: (k: string) => getSetting(k) }));
vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: (p: string) => getDefaultModel(p),
  fetchProviderModels: () => fetchProviderModels(),
}));
vi.mock("@/lib/model-vision", () => ({
  isModelVisionCapable: (m: string) => isModelVisionCapable(m),
}));
vi.mock("@/lib/model-capabilities/cache", () => ({
  ensureModelCapabilityCacheLoaded: () => Promise.resolve(),
}));

import { resolveDefaultVisionModelChain } from "@/lib/openclaw-config/default-media-models";

// Staging shape: OpenAI key present (invalid at runtime, but present at
// config-gen), ollama-cloud key present, anthropic/google unconfigured.
function stubStagingProviders() {
  getSetting.mockImplementation(async (key: string) =>
    key === "openai_api_key" || key === "ollama_cloud_api_key" ? "sk-present" : null
  );
  getDefaultModel.mockImplementation(async (provider: string) =>
    provider === "openai"
      ? "openai/gpt-5.5"
      : provider === "ollama-cloud"
        ? "ollama-cloud/kimi-k2.6"
        : null
  );
  // Live ollama-cloud catalog includes the curated vision model.
  fetchProviderModels.mockResolvedValue([
    { id: "ollama-cloud", models: [{ id: "ollama-cloud/gemini-3-flash-preview" }] },
  ]);
  // Chat default kimi-k2.6 is NOT vision-capable; gpt-5.5 is.
  isModelVisionCapable.mockImplementation((m: string) => m === "openai/gpt-5.5");
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("resolveDefaultVisionModelChain", () => {
  it("returns an ordered chain across configured providers so OpenClaw can fall back", async () => {
    stubStagingProviders();
    const chain = await resolveDefaultVisionModelChain();
    // openai (vision-fallback tier) leads; ollama-cloud follows as the graceful
    // fallback when the openai call fails (e.g. an invalid/expired key — the
    // staging symptom). This is the whole point of #2: a single pdfModel had no
    // fallback, so an unreachable primary silently killed PDF/vision.
    expect(chain).toEqual(["openai/gpt-5.5", "ollama-cloud/gemini-3-flash-preview"]);
  });

  it("resolves ollama-cloud to its curated VISION model, not the chat default", async () => {
    // Regression guard: the old resolver used getDefaultModel('ollama-cloud')
    // (kimi-k2.6, chat model, not reliably vision-capable) for the PDF slot.
    // The chain must use the curated image model (gemini-3-flash-preview).
    getSetting.mockImplementation(async (key: string) =>
      key === "ollama_cloud_api_key" ? "sk-present" : null
    );
    getDefaultModel.mockResolvedValue("ollama-cloud/kimi-k2.6");
    fetchProviderModels.mockResolvedValue([
      { id: "ollama-cloud", models: [{ id: "ollama-cloud/gemini-3-flash-preview" }] },
    ]);
    isModelVisionCapable.mockReturnValue(false);
    const chain = await resolveDefaultVisionModelChain();
    expect(chain).toEqual(["ollama-cloud/gemini-3-flash-preview"]);
  });

  it("returns an empty chain on a text-only stack", async () => {
    getSetting.mockResolvedValue(null);
    getDefaultModel.mockResolvedValue(null);
    fetchProviderModels.mockResolvedValue([]);
    isModelVisionCapable.mockReturnValue(false);
    expect(await resolveDefaultVisionModelChain()).toEqual([]);
  });

  it("serves BOTH the pdf and image tools from one resolution (build.ts emits it to both)", async () => {
    // The pdf and image tools share this chain — build.ts resolves it once and
    // emits it as pdfModel AND imageModel, so the live ollama-cloud catalog is
    // fetched a single time per config-gen (regression: two resolvers each
    // fetching consumed the #416 mockResolvedValueOnce and diverged the pick).
    stubStagingProviders();
    fetchProviderModels.mockClear();
    const chain = await resolveDefaultVisionModelChain();
    expect(chain).toEqual(["openai/gpt-5.5", "ollama-cloud/gemini-3-flash-preview"]);
    expect(fetchProviderModels).toHaveBeenCalledTimes(1);
  });
});
