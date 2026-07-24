import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  validateOpenAiCompatibleProvider,
  fetchOpenAiCompatibleModels,
  resolveCustomProviderModels,
  resetCustomModelCache,
  type CustomProviderModelSource,
} from "@/lib/openai-compatible-discovery";
import { DEFAULT_MODEL_CAPS } from "@/lib/model-catalog";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";

global.fetch = vi.fn();

describe("validateOpenAiCompatibleProvider", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns valid for a 200 response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await validateOpenAiCompatibleProvider("https://api.example.com/v1", "sk-key");

    expect(result).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-key",
        }),
      })
    );
  });

  it("retries exactly once on 401, then returns invalid_key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 401 }));

    const result = await validateOpenAiCompatibleProvider("https://api.example.com/v1", "sk-bad");

    expect(result).toEqual({ valid: false, error: "invalid_key" });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("succeeds if the single retry returns 200", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(new Response("{}", { status: 403 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));

    const result = await validateOpenAiCompatibleProvider("https://api.example.com/v1", "sk-key");

    expect(result).toEqual({ valid: true });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("returns provider_error for a non-auth non-2xx (500)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 500 }));

    const result = await validateOpenAiCompatibleProvider("https://api.example.com/v1", "sk-key");

    expect(result).toEqual({ valid: false, error: "provider_error", status: 500 });
  });

  it("returns network_error when fetch throws", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("boom"));

    const result = await validateOpenAiCompatibleProvider("https://api.example.com/v1", "sk-key");

    expect(result).toEqual({ valid: false, error: "network_error" });
  });

  it("normalizes a trailing slash on the base URL (no double slash)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    await validateOpenAiCompatibleProvider("https://api.example.com/v1/", "sk-key");

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.example.com/v1/models");
  });
});

describe("fetchOpenAiCompatibleModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolves known ids to real caps and unknown ids to DEFAULT_MODEL_CAPS", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "mistral-large-2512" }, { id: "totally-made-up-model-xyz" }],
        }),
        { status: 200 }
      )
    );

    const models = await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(models).toHaveLength(2);

    const known = models.find((m) => m.id === "mistral-large-2512");
    expect(known).toBeDefined();
    // Real snapshot context window, not the fallback default.
    expect(known!.contextWindow).toBe(262144);
    expect(known!.contextWindow).not.toBe(DEFAULT_MODEL_CAPS.contextWindow);

    const unknown = models.find((m) => m.id === "totally-made-up-model-xyz");
    expect(unknown).toBeDefined();
    expect(unknown!.contextWindow).toBe(DEFAULT_MODEL_CAPS.contextWindow);
    expect(unknown!.contextWindow).toBe(32768);
    expect(unknown!.name).toBe("totally-made-up-model-xyz");
  });

  it("normalizes a trailing slash on the base URL (no double slash)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    await fetchOpenAiCompatibleModels("https://api.example.com/v1/", "sk-key");

    expect(vi.mocked(fetch).mock.calls[0][0]).toBe("https://api.example.com/v1/models");
  });

  it("returns [] on a non-200 response (404)", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("nope", { status: 404 }));

    const models = await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(models).toEqual([]);
  });

  it("returns [] on a 500 response", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("boom", { status: 500 }));

    const models = await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(models).toEqual([]);
  });

  it("returns [] when fetch throws", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("boom"));

    const models = await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(models).toEqual([]);
  });

  it("returns [] when the body has no data array", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({}), { status: 200 }));

    const models = await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(models).toEqual([]);
  });

  it("skips malformed entries without an id rather than throwing", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{}, { id: "" }, { id: 42 }, { id: "gpt-5.5" }] }), {
        status: 200,
      })
    );

    const models = await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    // Only the one valid string id survives.
    expect(models.map((m) => m.id)).toEqual(["gpt-5.5"]);
  });

  it("filters out non-chat models (embeddings, rerankers, tts, whisper, moderation, guard)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "gpt-5.5" },
            { id: "text-embedding-3-large" },
            { id: "embedding-ada-002" },
            { id: "rerank-english-v3.0" },
            { id: "reranker-multilingual" },
            { id: "tts-1" },
            { id: "text-to-speech-v2" },
            { id: "whisper-1" },
            { id: "omni-moderation-latest" },
            { id: "llama-guard-3" },
            { id: "Whisper-Large-V3" }, // case-insensitive
          ],
        }),
        { status: 200 }
      )
    );

    const models = await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(models.map((m) => m.id)).toEqual(["gpt-5.5"]);
  });
});

describe("resolveCustomProviderModels", () => {
  const snapshot: OpenClawModelDefinition[] = [
    {
      id: "acme-snapshot",
      name: "Acme Snapshot",
      contextWindow: 8192,
      maxTokens: 4096,
      reasoning: false,
      vision: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    },
  ];

  function source(overrides: Partial<CustomProviderModelSource> = {}): CustomProviderModelSource {
    return {
      slug: "acme",
      baseUrl: "https://acme.example.com/v1",
      apiKey: "sk-key",
      models: snapshot,
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    resetCustomModelCache();
  });

  it("fetches live on a cache miss and returns the discovered models", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "acme-large" }] }), { status: 200 })
    );

    const result = await resolveCustomProviderModels(source());

    expect(result.map((m) => m.id)).toEqual(["acme-large"]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns the cached result within the TTL without refetching", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "acme-large" }] }), { status: 200 })
    );

    const first = await resolveCustomProviderModels(source());
    expect(fetch).toHaveBeenCalledTimes(1);

    vi.mocked(fetch).mockClear();
    const second = await resolveCustomProviderModels(source());

    expect(second).toEqual(first);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to the snapshot when live discovery returns zero models, without caching the empty result", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const result = await resolveCustomProviderModels(source());
    expect(result).toEqual(snapshot);

    // Not cached: the very next call retries live rather than pinning the
    // fallback for the whole TTL window.
    vi.mocked(fetch).mockClear();
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "acme-large" }] }), { status: 200 })
    );
    const retried = await resolveCustomProviderModels(source());
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(retried.map((m) => m.id)).toEqual(["acme-large"]);
  });

  it("falls back to the snapshot when live discovery throws, without caching", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("network down"));

    const result = await resolveCustomProviderModels(source());
    expect(result).toEqual(snapshot);
  });

  it("caches independently per slug", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.includes("acme")) {
        return new Response(JSON.stringify({ data: [{ id: "acme-large" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [{ id: "beta-large" }] }), { status: 200 });
    });

    const acme = await resolveCustomProviderModels(
      source({ slug: "acme", baseUrl: "https://acme.example.com/v1" })
    );
    const beta = await resolveCustomProviderModels(
      source({ slug: "beta-corp", baseUrl: "https://beta.example.com/v1", models: [] })
    );

    expect(acme.map((m) => m.id)).toEqual(["acme-large"]);
    expect(beta.map((m) => m.id)).toEqual(["beta-large"]);
  });
});
