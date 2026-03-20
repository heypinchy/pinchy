import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/providers", () => ({
  PROVIDERS: {
    anthropic: {
      name: "Anthropic",
      settingsKey: "anthropic_api_key",
      envVar: "ANTHROPIC_API_KEY",
      defaultModel: "anthropic/claude-haiku-4-5-20251001",
      placeholder: "sk-ant-...",
    },
    openai: {
      name: "OpenAI",
      settingsKey: "openai_api_key",
      envVar: "OPENAI_API_KEY",
      defaultModel: "openai/gpt-4o-mini",
      placeholder: "sk-...",
    },
    google: {
      name: "Google",
      settingsKey: "google_api_key",
      envVar: "GEMINI_API_KEY",
      defaultModel: "google/gemini-2.5-flash",
      placeholder: "AIza...",
    },
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

global.fetch = vi.fn();

import { fetchProviderModels, resetCache } from "@/lib/provider-models";
import { getSetting } from "@/lib/settings";

describe("fetchProviderModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  it("returns models grouped by configured provider", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test-key";
      return null;
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "claude-opus-4-6", display_name: "Claude Opus 4.6" },
            { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await fetchProviderModels();

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      id: "anthropic",
      name: "Anthropic",
      models: [
        { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
        { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      ],
    });
  });

  it("skips providers without stored keys", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);

    const result = await fetchProviderModels();

    expect(result).toHaveLength(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to hardcoded models when API fails", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test-key";
      return null;
    });

    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    const result = await fetchProviderModels();

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("anthropic");
    expect(result[0].models).toEqual([
      { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
      { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ]);
  });

  it("handles multiple configured providers", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test-key";
      if (key === "openai_api_key") return "sk-openai-test-key";
      return null;
    });

    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("anthropic")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "claude-opus-4-6", display_name: "Claude Opus 4.6" }],
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes("openai")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }, { id: "dall-e-3" }],
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    });

    const result = await fetchProviderModels();

    expect(result).toHaveLength(2);

    const anthropic = result.find((p) => p.id === "anthropic");
    expect(anthropic).toBeDefined();
    expect(anthropic!.models).toEqual([
      { id: "anthropic/claude-opus-4-6", name: "Claude Opus 4.6" },
    ]);

    const openai = result.find((p) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(openai!.models).toEqual([
      { id: "openai/gpt-4o", name: "gpt-4o" },
      { id: "openai/gpt-4o-mini", name: "gpt-4o-mini" },
    ]);
    // dall-e-3 should be filtered out (doesn't start with gpt- or o)
  });

  it("filters OpenAI models to gpt- and o- prefixed", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "openai_api_key") return "sk-openai-test";
      return null;
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-4o" },
            { id: "o1" },
            { id: "o3-mini" },
            { id: "dall-e-3" },
            { id: "text-embedding-3-large" },
            { id: "whisper-1" },
            { id: "omni-moderation-latest" },
            { id: "gpt-3.5-turbo-instruct" },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await fetchProviderModels();
    const openai = result.find((p) => p.id === "openai");
    expect(openai).toBeDefined();

    const modelIds = openai!.models.map((m) => m.id);
    expect(modelIds).toContain("openai/gpt-4o");
    expect(modelIds).toContain("openai/o1");
    expect(modelIds).toContain("openai/o3-mini");
    expect(modelIds).not.toContain("openai/dall-e-3");
    expect(modelIds).not.toContain("openai/text-embedding-3-large");
    expect(modelIds).not.toContain("openai/whisper-1");
    expect(modelIds).not.toContain("openai/omni-moderation-latest");
    expect(modelIds).not.toContain("openai/gpt-3.5-turbo-instruct");
  });

  it("filters Google models to those supporting generateContent", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "google_api_key") return "AIza-test";
      return null;
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          models: [
            {
              name: "models/gemini-2.5-flash",
              displayName: "Gemini 2.0 Flash",
              supportedGenerationMethods: ["generateContent"],
            },
            {
              name: "models/embedding-001",
              displayName: "Embedding 001",
              supportedGenerationMethods: ["embedContent"],
            },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await fetchProviderModels();
    const google = result.find((p) => p.id === "google");
    expect(google).toBeDefined();
    expect(google!.models).toEqual([{ id: "google/gemini-2.5-flash", name: "Gemini 2.0 Flash" }]);
  });

  it("uses fallback models when API returns non-ok status", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "openai_api_key") return "sk-openai-test";
      return null;
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ error: "Invalid API key" }), {
        status: 401,
      })
    );

    const result = await fetchProviderModels();
    const openai = result.find((p) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(openai!.models).toEqual([
      { id: "openai/gpt-4o", name: "GPT-4o" },
      { id: "openai/gpt-4o-mini", name: "GPT-4o Mini" },
      { id: "openai/o1", name: "o1" },
    ]);
  });

  it("caches results for subsequent calls", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test-key";
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4-6", display_name: "Claude Opus 4.6" }] }),
        { status: 200 }
      )
    );

    await fetchProviderModels();
    await fetchProviderModels();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("resetCache() causes next call to fetch fresh data", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test-key";
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4-6", display_name: "Claude Opus 4.6" }] }),
        { status: 200 }
      )
    );

    await fetchProviderModels();
    resetCache();
    await fetchProviderModels();

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("vision capability detection", () => {
  it("marks anthropic, openai, google as vision-capable providers", async () => {
    const { VISION_CAPABLE_PROVIDERS } = await import("@/lib/provider-models");
    expect(VISION_CAPABLE_PROVIDERS).toContain("anthropic");
    expect(VISION_CAPABLE_PROVIDERS).toContain("openai");
    expect(VISION_CAPABLE_PROVIDERS).toContain("google");
  });

  it("detects vision capability from model ID", async () => {
    const { isModelVisionCapable } = await import("@/lib/provider-models");

    // Cloud providers are vision-capable
    expect(isModelVisionCapable("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(isModelVisionCapable("openai/gpt-4o")).toBe(true);
    expect(isModelVisionCapable("google/gemini-2.5-flash")).toBe(true);

    // Unknown provider → not vision-capable (conservative default)
    expect(isModelVisionCapable("ollama/llama3.1:8b")).toBe(false);
    expect(isModelVisionCapable("unknown/model")).toBe(false);

    // Known vision-capable Ollama models
    expect(isModelVisionCapable("ollama/llava")).toBe(true);
    expect(isModelVisionCapable("ollama/llama3.2-vision")).toBe(true);
    expect(isModelVisionCapable("ollama/qwen2.5-vl:7b")).toBe(true);
  });
});
