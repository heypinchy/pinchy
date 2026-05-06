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
      defaultModel: "openai/gpt-5.4-mini",
      placeholder: "sk-...",
    },
    google: {
      name: "Google",
      settingsKey: "google_api_key",
      envVar: "GEMINI_API_KEY",
      defaultModel: "google/gemini-2.5-flash",
      placeholder: "AIza...",
    },
    "ollama-cloud": {
      name: "Ollama Cloud",
      settingsKey: "ollama_cloud_api_key",
      envVar: "OLLAMA_CLOUD_API_KEY",
      defaultModel: "ollama-cloud/gemini-3-flash-preview",
      placeholder: "sk-...",
    },
    "ollama-local": {
      name: "Ollama (Local)",
      authType: "url",
      settingsKey: "ollama_local_url",
      envVar: "",
      defaultModel: "",
      placeholder: "http://host.docker.internal:11434",
    },
  },
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

global.fetch = vi.fn();

import {
  fetchProviderModels,
  resetCache,
  getOllamaLocalModels,
  fetchOllamaLocalModelsFromUrl,
} from "@/lib/provider-models";
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
            { id: "claude-opus-4-7", display_name: "Claude Opus 4.7" },
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
        { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7" },
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
      { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7" },
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
            data: [{ id: "claude-opus-4-7", display_name: "Claude Opus 4.7" }],
          }),
          { status: 200 }
        );
      }
      if (urlStr.includes("openai")) {
        return new Response(
          JSON.stringify({
            data: [{ id: "gpt-5.4" }, { id: "gpt-5.4-mini" }, { id: "dall-e-3" }],
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
      { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7" },
    ]);

    const openai = result.find((p) => p.id === "openai");
    expect(openai).toBeDefined();
    expect(openai!.models).toEqual([
      { id: "openai/gpt-5.4", name: "gpt-5.4" },
      { id: "openai/gpt-5.4-mini", name: "gpt-5.4-mini" },
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
            { id: "gpt-5.4" },
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
    expect(modelIds).toContain("openai/gpt-5.4");
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

  it("surfaces every tool-capable Ollama Cloud model and filters the rest", async () => {
    // Allowlist is derived from each model's "tools" capability tag on its
    // ollama.com/library/<name> page, not the aggregate search page — the
    // search listing under c=tools&c=cloud is incomplete and omits several
    // tool-capable cloud models (gpt-oss, qwen3-vl, mistral-large-3, etc.).
    // Real IDs as returned by https://ollama.com/v1/models today — no
    // ":cloud"/"-cloud" suffixes.
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-test";
      return null;
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            // Tool-capable — should appear
            { id: "deepseek-v3.1:671b" },
            { id: "deepseek-v3.2" },
            { id: "deepseek-v4-flash" },
            { id: "deepseek-v4-pro" },
            { id: "devstral-2:123b" },
            { id: "devstral-small-2:24b" },
            { id: "gemini-3-flash-preview" },
            { id: "gemma4:31b" },
            { id: "glm-4.6" },
            { id: "glm-4.7" },
            { id: "glm-5" },
            { id: "glm-5.1" },
            { id: "gpt-oss:20b" },
            { id: "gpt-oss:120b" },
            { id: "kimi-k2-thinking" },
            { id: "kimi-k2.5" },
            { id: "kimi-k2.6" },
            { id: "minimax-m2" },
            { id: "minimax-m2.1" },
            { id: "minimax-m2.5" },
            { id: "minimax-m2.7" },
            { id: "ministral-3:3b" },
            { id: "ministral-3:8b" },
            { id: "ministral-3:14b" },
            { id: "mistral-large-3:675b" },
            { id: "nemotron-3-nano:30b" },
            { id: "nemotron-3-super" },
            { id: "qwen3-coder-next" },
            { id: "qwen3-coder:480b" },
            { id: "qwen3-next:80b" },
            { id: "qwen3-vl:235b" },
            { id: "qwen3-vl:235b-instruct" },
            { id: "qwen3.5:397b" },
            { id: "rnj-1:8b" },
            // Not tool-capable per ollama.com library pages — must be filtered out
            { id: "cogito-2.1:671b" },
            { id: "gemma3:27b" },
            { id: "gemma3:12b" },
            { id: "gemma3:4b" },
            { id: "kimi-k2:1t" },
          ],
        }),
        { status: 200 }
      )
    );

    const result = await fetchProviderModels();
    const ollama = result.find((p) => p.id === "ollama-cloud");
    expect(ollama).toBeDefined();
    const ids = ollama!.models.map((m) => m.id);

    // Every tool-capable model surfaces
    expect(ids).toEqual(
      expect.arrayContaining([
        "ollama-cloud/deepseek-v3.1:671b",
        "ollama-cloud/deepseek-v3.2",
        "ollama-cloud/deepseek-v4-flash",
        "ollama-cloud/deepseek-v4-pro",
        "ollama-cloud/devstral-2:123b",
        "ollama-cloud/devstral-small-2:24b",
        "ollama-cloud/gemini-3-flash-preview",
        "ollama-cloud/gemma4:31b",
        "ollama-cloud/glm-4.6",
        "ollama-cloud/glm-4.7",
        "ollama-cloud/glm-5",
        "ollama-cloud/glm-5.1",
        "ollama-cloud/gpt-oss:20b",
        "ollama-cloud/gpt-oss:120b",
        "ollama-cloud/kimi-k2-thinking",
        "ollama-cloud/kimi-k2.5",
        "ollama-cloud/kimi-k2.6",
        "ollama-cloud/minimax-m2",
        "ollama-cloud/minimax-m2.1",
        "ollama-cloud/minimax-m2.5",
        "ollama-cloud/minimax-m2.7",
        "ollama-cloud/ministral-3:3b",
        "ollama-cloud/ministral-3:8b",
        "ollama-cloud/ministral-3:14b",
        "ollama-cloud/mistral-large-3:675b",
        "ollama-cloud/nemotron-3-nano:30b",
        "ollama-cloud/nemotron-3-super",
        "ollama-cloud/qwen3-coder-next",
        "ollama-cloud/qwen3-coder:480b",
        "ollama-cloud/qwen3-next:80b",
        "ollama-cloud/qwen3-vl:235b",
        "ollama-cloud/qwen3-vl:235b-instruct",
        "ollama-cloud/qwen3.5:397b",
        "ollama-cloud/rnj-1:8b",
      ])
    );
    expect(ids).toHaveLength(34);

    // Non-tool-capable models are filtered out
    expect(ids).not.toContain("ollama-cloud/kimi-k2:1t");
    expect(ids).not.toContain("ollama-cloud/gemma3:27b");
    expect(ids).not.toContain("ollama-cloud/gemma3:12b");
    expect(ids).not.toContain("ollama-cloud/gemma3:4b");
    expect(ids).not.toContain("ollama-cloud/cogito-2.1:671b");
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
      { id: "openai/gpt-5.5", name: "GPT-5.5" },
      { id: "openai/gpt-5.4", name: "GPT-5.4" },
      { id: "openai/gpt-5.4-mini", name: "GPT-5.4 Mini" },
    ]);
  });

  it("falls back to every tool-capable cloud model when Ollama Cloud API fails", async () => {
    // If the API errors out (rate limit, transient 5xx, network hiccup), the
    // fallback must still list every tool-capable model — otherwise a single
    // flaky fetch would silently shrink the admin's model picker.
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_cloud_api_key") return "sk-ollama-fallback";
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(new Response("boom", { status: 503 }));

    const result = await fetchProviderModels();
    const ollama = result.find((p) => p.id === "ollama-cloud");
    expect(ollama).toBeDefined();
    const ids = ollama!.models.map((m) => m.id);
    expect(ids).toHaveLength(34);
    expect(ids).toEqual(
      expect.arrayContaining([
        "ollama-cloud/deepseek-v3.1:671b",
        "ollama-cloud/deepseek-v3.2",
        "ollama-cloud/deepseek-v4-flash",
        "ollama-cloud/deepseek-v4-pro",
        "ollama-cloud/devstral-2:123b",
        "ollama-cloud/devstral-small-2:24b",
        "ollama-cloud/gemini-3-flash-preview",
        "ollama-cloud/gemma4:31b",
        "ollama-cloud/glm-4.6",
        "ollama-cloud/glm-4.7",
        "ollama-cloud/glm-5",
        "ollama-cloud/glm-5.1",
        "ollama-cloud/gpt-oss:20b",
        "ollama-cloud/gpt-oss:120b",
        "ollama-cloud/kimi-k2-thinking",
        "ollama-cloud/kimi-k2.5",
        "ollama-cloud/kimi-k2.6",
        "ollama-cloud/minimax-m2",
        "ollama-cloud/minimax-m2.1",
        "ollama-cloud/minimax-m2.5",
        "ollama-cloud/minimax-m2.7",
        "ollama-cloud/ministral-3:3b",
        "ollama-cloud/ministral-3:8b",
        "ollama-cloud/ministral-3:14b",
        "ollama-cloud/mistral-large-3:675b",
        "ollama-cloud/nemotron-3-nano:30b",
        "ollama-cloud/nemotron-3-super",
        "ollama-cloud/qwen3-coder-next",
        "ollama-cloud/qwen3-coder:480b",
        "ollama-cloud/qwen3-next:80b",
        "ollama-cloud/qwen3-vl:235b",
        "ollama-cloud/qwen3-vl:235b-instruct",
        "ollama-cloud/qwen3.5:397b",
        "ollama-cloud/rnj-1:8b",
      ])
    );
  });

  it("caches results for subsequent calls", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test-key";
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4-7", display_name: "Claude Opus 4.7" }] }),
        { status: 200 }
      )
    );

    await fetchProviderModels();
    await fetchProviderModels();

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("fetches local Ollama models via /api/tags and /api/show", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://localhost:11434";
      return null;
    });

    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "llama3:latest", details: { parameter_size: "8B" } },
              { name: "mistral:7b", details: { parameter_size: "7B" } },
            ],
          }),
          { status: 200 }
        );
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            details: { parameter_size: "8B" },
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    });

    const result = await fetchProviderModels();
    const ollamaLocal = result.find((p) => p.id === "ollama-local");
    expect(ollamaLocal).toBeDefined();
    expect(ollamaLocal!.name).toBe("Ollama (Local)");
    expect(ollamaLocal!.models).toHaveLength(2);
    expect(ollamaLocal!.models[0]).toEqual(expect.objectContaining({ id: "ollama/llama3:latest" }));
    expect(ollamaLocal!.models[1]).toEqual(expect.objectContaining({ id: "ollama/mistral:7b" }));
  });

  it("filters out embedding-only models from local Ollama", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://localhost:11434";
      return null;
    });

    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [
              { name: "llama3:latest", details: { parameter_size: "8B" } },
              { name: "nomic-embed-text:latest", details: { parameter_size: "137M" } },
            ],
          }),
          { status: 200 }
        );
      }
      if (urlStr.endsWith("/api/show")) {
        const body = JSON.parse((init as RequestInit)?.body as string);
        if (body.name === "nomic-embed-text:latest") {
          return new Response(
            JSON.stringify({
              capabilities: ["embedding"],
              details: { parameter_size: "137M" },
            }),
            { status: 200 }
          );
        }
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            details: { parameter_size: "8B" },
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    });

    const result = await fetchProviderModels();
    const ollamaLocal = result.find((p) => p.id === "ollama-local");
    expect(ollamaLocal).toBeDefined();
    const modelIds = ollamaLocal!.models.map((m) => m.id);
    expect(modelIds).toContain("ollama/llama3:latest");
    expect(modelIds).not.toContain("ollama/nomic-embed-text:latest");
  });

  it("returns empty models when local Ollama is unreachable", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://localhost:11434";
      return null;
    });

    vi.mocked(fetch).mockRejectedValue(new Error("ECONNREFUSED"));

    const result = await fetchProviderModels();
    const ollamaLocal = result.find((p) => p.id === "ollama-local");
    expect(ollamaLocal).toBeDefined();
    expect(ollamaLocal!.models).toEqual([]);
  });

  it("marks Ollama models without tool support as incompatible", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://localhost:11434";
      return null;
    });

    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [{ name: "phi3:mini", details: { parameter_size: "3.8B" } }],
          }),
          { status: 200 }
        );
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            capabilities: ["completion"], // no "tools"
            details: { parameter_size: "3.8B" },
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    });

    const result = await fetchProviderModels();
    const ollamaLocal = result.find((p) => p.id === "ollama-local");
    expect(ollamaLocal).toBeDefined();
    const model = ollamaLocal!.models[0];
    expect(model.compatible).toBe(false);
    expect(model.incompatibleReason).toContain("does not support agent tools");
  });

  it("marks Ollama models with tool support as compatible", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://localhost:11434";
      return null;
    });

    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [{ name: "qwen2.5:7b", details: { parameter_size: "7B" } }],
          }),
          { status: 200 }
        );
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            details: { parameter_size: "7B" },
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    });

    const result = await fetchProviderModels();
    const ollamaLocal = result.find((p) => p.id === "ollama-local");
    const model = ollamaLocal!.models[0];
    expect(model.compatible).toBe(true);
    expect(model.incompatibleReason).toBeUndefined();
  });

  it("cloud provider models have no compatible field set", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test";
      return null;
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [{ id: "claude-opus-4-7", display_name: "Claude Opus 4.7" }],
        }),
        { status: 200 }
      )
    );

    const result = await fetchProviderModels();
    const anthropic = result.find((p) => p.id === "anthropic");
    expect(anthropic!.models[0].compatible).toBeUndefined();
    expect(anthropic!.models[0].incompatibleReason).toBeUndefined();
  });

  it("does not include ollama-local when URL is not configured", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);

    const result = await fetchProviderModels();
    const ollamaLocal = result.find((p) => p.id === "ollama-local");
    expect(ollamaLocal).toBeUndefined();
  });

  it("populates getOllamaLocalModels after fetching", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "ollama_local_url") return "http://localhost:11434";
      return null;
    });

    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({
            models: [{ name: "llama3:latest", details: { parameter_size: "8B" } }],
          }),
          { status: 200 }
        );
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "vision"],
            details: { parameter_size: "8B" },
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    });

    await fetchProviderModels();
    const models = getOllamaLocalModels();
    expect(models).toHaveLength(1);
    expect(models[0].capabilities.vision).toBe(true);
    expect(models[0].capabilities.completion).toBe(true);
    expect(models[0].parameterSize).toBe("8B");
  });

  it("resetCache() causes next call to fetch fresh data", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test-key";
      return null;
    });
    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ id: "claude-opus-4-7", display_name: "Claude Opus 4.7" }] }),
        { status: 200 }
      )
    );

    await fetchProviderModels();
    resetCache();
    await fetchProviderModels();

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("selectDefaultModel", () => {
  it("selects the smallest Anthropic model (haiku pattern)", async () => {
    const { selectDefaultModel } = await import("@/lib/provider-models");
    const models = [
      { id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7" },
      { id: "anthropic/claude-sonnet-4-6", name: "Claude Sonnet 4.6" },
      { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ];
    expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("selects the mini OpenAI model (gpt-*-mini pattern)", async () => {
    const { selectDefaultModel } = await import("@/lib/provider-models");
    const models = [
      { id: "openai/gpt-5.4", name: "gpt-5.4" },
      { id: "openai/gpt-5.4-mini", name: "gpt-5.4-mini" },
      { id: "openai/o1", name: "o1" },
    ];
    expect(selectDefaultModel("openai", models)).toBe("openai/gpt-5.4-mini");
  });

  it("selects the flash Google model (gemini-*-flash pattern)", async () => {
    const { selectDefaultModel } = await import("@/lib/provider-models");
    const models = [
      { id: "google/gemini-2.5-pro", name: "Gemini 2.5 Pro" },
      { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash" },
    ];
    expect(selectDefaultModel("google", models)).toBe("google/gemini-2.5-flash");
  });

  it("falls back to hardcoded default when all flash candidates are preview versions (ollama)", async () => {
    const { selectDefaultModel } = await import("@/lib/provider-models");
    const models = [
      { id: "ollama-cloud/kimi-k2.5", name: "Kimi K2.5" },
      { id: "ollama-cloud/gemini-3-flash-preview", name: "Gemini 3 Flash Preview" },
      { id: "ollama-cloud/qwen3.5:397b", name: "Qwen 3.5 397B" },
    ];
    expect(selectDefaultModel("ollama-cloud", models)).toBe("ollama-cloud/gemini-3-flash-preview");
  });

  it("prefers stable versions over preview versions", async () => {
    const { selectDefaultModel } = await import("@/lib/provider-models");
    const models = [
      { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
      { id: "anthropic/claude-haiku-4-5-20251001-preview", name: "Claude Haiku 4.5 Preview" },
    ];
    expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("selects the most recent model when multiple versions match", async () => {
    const { selectDefaultModel } = await import("@/lib/provider-models");
    const models = [
      { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
      { id: "anthropic/claude-3-haiku-20240307", name: "Claude 3 Haiku" },
    ];
    expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("selects the most recent model regardless of list order", async () => {
    const { selectDefaultModel } = await import("@/lib/provider-models");
    const models = [
      { id: "anthropic/claude-3-haiku-20240307", name: "Claude 3 Haiku" },
      { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
    ];
    expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("falls back to hardcoded default when no pattern matches", async () => {
    const { selectDefaultModel } = await import("@/lib/provider-models");
    const models = [{ id: "anthropic/claude-opus-4-7", name: "Claude Opus 4.7" }];
    // No haiku in the list — falls back to PROVIDERS[provider].defaultModel
    expect(selectDefaultModel("anthropic", models)).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("falls back to hardcoded default when model list is empty", async () => {
    const { selectDefaultModel } = await import("@/lib/provider-models");
    expect(selectDefaultModel("openai", [])).toBe("openai/gpt-5.4-mini");
  });
});

describe("getDefaultModel", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
    vi.mocked(getSetting).mockResolvedValue(null);
  });

  it("returns dynamically selected model from live model list", async () => {
    vi.mocked(getSetting).mockImplementation(async (key: string) => {
      if (key === "anthropic_api_key") return "sk-ant-test-key";
      return null;
    });

    vi.mocked(fetch).mockResolvedValue(
      new Response(
        JSON.stringify({
          data: [
            { id: "claude-opus-4-7", display_name: "Claude Opus 4.7" },
            { id: "claude-sonnet-4-6", display_name: "Claude Sonnet 4.6" },
            { id: "claude-haiku-4-5-20251001", display_name: "Claude Haiku 4.5" },
          ],
        }),
        { status: 200 }
      )
    );

    const { getDefaultModel } = await import("@/lib/provider-models");
    const model = await getDefaultModel("anthropic");
    expect(model).toBe("anthropic/claude-haiku-4-5-20251001");
  });

  it("falls back to hardcoded default when provider has no API key", async () => {
    vi.mocked(getSetting).mockResolvedValue(null);

    const { getDefaultModel } = await import("@/lib/provider-models");
    const model = await getDefaultModel("openai");
    expect(model).toBe("openai/gpt-5.4-mini");
  });
});

describe("selectOllamaLocalDefault", () => {
  it("selects the largest model with tool support", async () => {
    const { selectOllamaLocalDefault } = await import("@/lib/provider-models");
    const models = [
      {
        id: "ollama/llama3:latest",
        name: "llama3:latest (8B)",
        parameterSize: "8B",
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
      {
        id: "ollama/qwen2.5:32b",
        name: "qwen2.5:32b (32B)",
        parameterSize: "32B",
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
      {
        id: "ollama/phi3:mini",
        name: "phi3:mini (3.8B)",
        parameterSize: "3.8B",
        capabilities: { tools: false, vision: false, completion: true, thinking: false },
      },
    ];
    expect(selectOllamaLocalDefault(models)).toBe("ollama/qwen2.5:32b");
  });

  it("falls back to largest completion model when no model supports tools", async () => {
    const { selectOllamaLocalDefault } = await import("@/lib/provider-models");
    const models = [
      {
        id: "ollama/phi3:mini",
        name: "phi3:mini (3.8B)",
        parameterSize: "3.8B",
        capabilities: { tools: false, vision: false, completion: true, thinking: false },
      },
      {
        id: "ollama/llama2:7b",
        name: "llama2:7b (7B)",
        parameterSize: "7B",
        capabilities: { tools: false, vision: false, completion: true, thinking: false },
      },
    ];
    expect(selectOllamaLocalDefault(models)).toBe("ollama/llama2:7b");
  });

  it("prefers qwen models over larger non-qwen models", async () => {
    const { selectOllamaLocalDefault } = await import("@/lib/provider-models");
    const models = [
      {
        id: "ollama/llama3.1:8b",
        name: "llama3.1:8b (8B)",
        parameterSize: "8B",
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
      {
        id: "ollama/qwen2.5:7b",
        name: "qwen2.5:7b (7B)",
        parameterSize: "7B",
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ];
    expect(selectOllamaLocalDefault(models)).toBe("ollama/qwen2.5:7b");
  });

  it("prefers largest qwen model when multiple qwen models available", async () => {
    const { selectOllamaLocalDefault } = await import("@/lib/provider-models");
    const models = [
      {
        id: "ollama/qwen2.5:3b",
        name: "qwen2.5:3b (3B)",
        parameterSize: "3B",
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
      {
        id: "ollama/qwen2.5:14b",
        name: "qwen2.5:14b (14B)",
        parameterSize: "14B",
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ];
    expect(selectOllamaLocalDefault(models)).toBe("ollama/qwen2.5:14b");
  });

  it("falls back to largest tool-capable model when no qwen available", async () => {
    const { selectOllamaLocalDefault } = await import("@/lib/provider-models");
    const models = [
      {
        id: "ollama/llama3.1:8b",
        name: "llama3.1:8b (8B)",
        parameterSize: "8B",
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
      {
        id: "ollama/mistral:7b",
        name: "mistral:7b (7B)",
        parameterSize: "7B",
        capabilities: { tools: true, vision: false, completion: true, thinking: false },
      },
    ];
    expect(selectOllamaLocalDefault(models)).toBe("ollama/llama3.1:8b");
  });

  it("returns empty string when no models available", async () => {
    const { selectOllamaLocalDefault } = await import("@/lib/provider-models");
    expect(selectOllamaLocalDefault([])).toBe("");
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
    const { setOllamaLocalVisionModels } = await import("@/lib/model-vision");

    // Cloud providers are vision-capable
    expect(isModelVisionCapable("anthropic/claude-sonnet-4-6")).toBe(true);
    expect(isModelVisionCapable("openai/gpt-5.4")).toBe(true);
    expect(isModelVisionCapable("google/gemini-2.5-flash")).toBe(true);

    // ollama-cloud provider → all models vision-capable
    expect(isModelVisionCapable("ollama-cloud/qwen3.5:397b")).toBe(true);
    expect(isModelVisionCapable("ollama-cloud/kimi-k2.5")).toBe(true);

    // Unknown provider → not vision-capable (conservative default)
    expect(isModelVisionCapable("unknown/model")).toBe(false);

    // Local ollama → per-model check (reset cache to use hardcoded fallback)
    setOllamaLocalVisionModels(null);
    expect(isModelVisionCapable("ollama/llama3.1:8b")).toBe(false);
    expect(isModelVisionCapable("ollama/llava")).toBe(true);
    expect(isModelVisionCapable("ollama/llama3.2-vision")).toBe(true);
  });
});

describe("fetchOllamaLocalModelsFromUrl contextLength extraction", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
  });

  it("extracts <arch>.context_length from /api/show model_info into contextLength", async () => {
    // Ollama's /api/show response carries a `model_info` map keyed by
    // architecture, e.g. { "qwen2.context_length": 32768, ... }. We surface
    // this as a top-level `contextLength` so build.ts can emit a real
    // contextWindow per model rather than a hardcoded fallback.
    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 });
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            details: { parameter_size: "7B" },
            model_info: {
              "qwen2.context_length": 32_768,
              "qwen2.embedding_length": 3584,
            },
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    });

    const result = await fetchOllamaLocalModelsFromUrl("http://localhost:11434");
    expect(result).toHaveLength(1);
    expect(result[0].contextLength).toBe(32_768);
  });

  it("leaves contextLength undefined when model_info is absent (older Ollama)", async () => {
    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 });
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            // model_info absent
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    });

    const result = await fetchOllamaLocalModelsFromUrl("http://localhost:11434");
    expect(result).toHaveLength(1);
    expect(result[0].contextLength).toBeUndefined();
  });

  it("leaves contextLength undefined when no <arch>.context_length key is found", async () => {
    // Different architectures use different prefixes; if none match the
    // *.context_length pattern we shouldn't crash, just leave the value out.
    vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "weirdarch:7b" }] }), {
          status: 200,
        });
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(
          JSON.stringify({
            capabilities: ["completion", "tools"],
            model_info: {
              "weirdarch.embedding_length": 1024,
              // no *.context_length
            },
          }),
          { status: 200 }
        );
      }
      return new Response("{}", { status: 404 });
    });

    const result = await fetchOllamaLocalModelsFromUrl("http://localhost:11434");
    expect(result[0].contextLength).toBeUndefined();
  });
});

describe("fetchOllamaLocalModelsFromUrl caching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
  });

  it("caches results per URL so back-to-back calls within the TTL skip the network", async () => {
    // regenerateOpenClawConfig() runs on every settings change. Without a
    // cache, a quick burst of saves triggers N+1 HTTP calls per save —
    // 5 s timeout per /api/show call when Ollama is down. A short in-process
    // TTL absorbs the burst without making the data stale beyond a few seconds.
    const fetchMock = vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ capabilities: ["completion", "tools"] }), {
        status: 200,
      });
    });

    await fetchOllamaLocalModelsFromUrl("http://localhost:11434");
    const callsAfterFirst = fetchMock.mock.calls.length;
    expect(callsAfterFirst).toBeGreaterThan(0);

    // Second call immediately after — must NOT hit the network again.
    await fetchOllamaLocalModelsFromUrl("http://localhost:11434");
    expect(fetchMock.mock.calls.length).toBe(callsAfterFirst);
  });

  it("uses a separate cache entry per URL", async () => {
    // A cache keyed only by call-site (and not by URL) would return cached
    // results for the wrong URL after the user changes it in settings.
    const fetchMock = vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ capabilities: ["completion", "tools"] }), {
        status: 200,
      });
    });

    await fetchOllamaLocalModelsFromUrl("http://localhost:11434");
    const callsAfterFirstUrl = fetchMock.mock.calls.length;

    await fetchOllamaLocalModelsFromUrl("http://192.168.1.50:11434");
    // Different URL must trigger a fresh fetch — at least the /api/tags call.
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirstUrl);
  });

  it("resetCache() invalidates the cache so the next call re-fetches", async () => {
    const fetchMock = vi.mocked(fetch).mockImplementation(async (url) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ capabilities: ["completion", "tools"] }), {
        status: 200,
      });
    });

    await fetchOllamaLocalModelsFromUrl("http://localhost:11434");
    const callsAfterFirst = fetchMock.mock.calls.length;

    resetCache();
    await fetchOllamaLocalModelsFromUrl("http://localhost:11434");
    expect(fetchMock.mock.calls.length).toBeGreaterThan(callsAfterFirst);
  });
});

describe("fetchOllamaLocalModelsFromUrl timeout behavior", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCache();
  });

  it("passes an AbortSignal to every fetch call so a hanging Ollama instance cannot wedge the request", async () => {
    const signals: (AbortSignal | undefined)[] = [];

    vi.mocked(fetch).mockImplementation(async (url, init) => {
      signals.push(init?.signal as AbortSignal | undefined);
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(
          JSON.stringify({ models: [{ name: "qwen3.5:9b" }, { name: "llama3:8b" }] }),
          { status: 200 }
        );
      }
      if (urlStr.endsWith("/api/show")) {
        return new Response(JSON.stringify({ capabilities: ["completion", "tools"] }), {
          status: 200,
        });
      }
      return new Response("{}", { status: 404 });
    });

    await fetchOllamaLocalModelsFromUrl("http://localhost:11434");

    // 1 tags + 2 show calls
    expect(signals).toHaveLength(3);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
  });

  it("returns (rather than hangs) when a per-model fetch is aborted", async () => {
    // Tags response succeeds, but the show call rejects on abort — proves
    // that the implementation passes a signal we can use to break out and
    // that an aborted show call doesn't crash the loop.
    vi.mocked(fetch).mockImplementation(async (url, init) => {
      const urlStr = typeof url === "string" ? url : url.toString();
      if (urlStr.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen3.5:9b" }] }), { status: 200 });
      }
      // Pretend the call was aborted immediately — the kind of error
      // AbortSignal.timeout() raises in production.
      const err = new DOMException("aborted", "AbortError");
      // The signal was already passed in by the caller; we just need to
      // throw something that fetch() would normally throw on abort.
      throw err;
    });

    const result = await fetchOllamaLocalModelsFromUrl("http://localhost:11434");
    // The aborted show call should be skipped, not propagated, leaving
    // an empty model list rather than an unhandled exception.
    expect(result).toEqual([]);
  });
});
