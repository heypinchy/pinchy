import { describe, it, expect, vi, beforeEach } from "vitest";
import { validateProviderKey, PROVIDERS } from "@/lib/providers";

global.fetch = vi.fn();

describe("validateProviderKey", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return true for valid Anthropic key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await validateProviderKey("anthropic", "sk-ant-valid");

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-api-key": "sk-ant-valid",
        }),
      })
    );
  });

  it("should return false for invalid Anthropic key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 401 }));

    const result = await validateProviderKey("anthropic", "sk-ant-invalid");
    expect(result).toBe(false);
  });

  it("should return true for valid OpenAI key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await validateProviderKey("openai", "sk-valid");

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-valid",
        }),
      })
    );
  });

  it("should return true for valid Google key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const result = await validateProviderKey("google", "AIza-valid");

    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://generativelanguage.googleapis.com/v1/models?key=AIza-valid",
      expect.any(Object)
    );
  });

  it("should return true for valid Ollama key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await validateProviderKey("ollama", "sk-ollama-valid");
    expect(result).toBe(true);
    expect(fetch).toHaveBeenCalledWith(
      "https://ollama.com/v1/models",
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Bearer sk-ollama-valid",
        }),
      })
    );
  });

  it("should return false for invalid Ollama key", async () => {
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 401 }));
    const result = await validateProviderKey("ollama", "sk-ollama-invalid");
    expect(result).toBe(false);
  });

  it("should return false on network error", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    const result = await validateProviderKey("anthropic", "sk-ant-key");
    expect(result).toBe(false);
  });

  it("should reject unknown provider", async () => {
    await expect(validateProviderKey("unknown" as any, "key")).rejects.toThrow("Unknown provider");
  });
});

describe("PROVIDERS", () => {
  it("should have default models for all providers", () => {
    expect(PROVIDERS.anthropic.defaultModel).toBe("anthropic/claude-haiku-4-5-20251001");
    expect(PROVIDERS.openai.defaultModel).toBe("openai/gpt-4o-mini");
    expect(PROVIDERS.google.defaultModel).toBe("google/gemini-2.5-flash");
    expect(PROVIDERS.ollama.defaultModel).toBe("ollama-cloud/gemini-3-flash-preview:cloud");
  });

  it("should have settings keys for all providers", () => {
    expect(PROVIDERS.anthropic.settingsKey).toBe("anthropic_api_key");
    expect(PROVIDERS.openai.settingsKey).toBe("openai_api_key");
    expect(PROVIDERS.google.settingsKey).toBe("google_api_key");
    expect(PROVIDERS.ollama.settingsKey).toBe("ollama_api_key");
  });

  it("should have display names for all providers", () => {
    expect(PROVIDERS.anthropic.name).toBe("Anthropic");
    expect(PROVIDERS.openai.name).toBe("OpenAI");
    expect(PROVIDERS.google.name).toBe("Google");
    expect(PROVIDERS.ollama.name).toBe("Ollama");
  });

  it("should have placeholder text for all providers", () => {
    expect(PROVIDERS.anthropic.placeholder).toBe("sk-ant-...");
    expect(PROVIDERS.openai.placeholder).toBe("sk-...");
    expect(PROVIDERS.google.placeholder).toBe("AIza...");
    expect(PROVIDERS.ollama.placeholder).toBe("sk-...");
  });
});
