// @vitest-environment node
import { describe, it, expect, vi, afterEach } from "vitest";
import { describePageImage, createVisionConfig } from "./pdf-vision-api";

describe("describePageImage", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("calls Anthropic API with correct format for anthropic models", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Extracted text from page" }],
      }),
    });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result?.text).toBe("Extracted text from page");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.anthropic.com/v1/messages",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("returns null when API key is not available", async () => {
    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => null,
    });

    expect(result).toBeNull();
  });

  it("returns null for unknown providers", async () => {
    const result = await describePageImage("base64data", {
      model: "unknown/some-model",
      resolveApiKey: async () => "key",
    });

    expect(result).toBeNull();
  });

  it("returns null on API error (non-retryable)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: async () => "Internal Server Error",
    });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toBeNull();
  });

  it("retries on 429 rate limit and succeeds", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "0" }),
        text: async () => "Rate limited",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Extracted after retry" }],
        }),
      });
    globalThis.fetch = mockFetch;

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result?.text).toBe("Extracted after retry");
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("gives up after max retries on repeated 429", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "retry-after": "0" }),
      text: async () => "Rate limited",
    });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toBeNull();
    expect((globalThis.fetch as any).mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("clamps an oversized Retry-After header to 30s instead of sleeping for a day", async () => {
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        // A malicious/misbehaving provider sending a 24h Retry-After.
        headers: new Headers({ "retry-after": "86400" }),
        text: async () => "Rate limited",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Extracted after retry" }],
        }),
      });
    globalThis.fetch = mockFetch;

    const waits: number[] = [];
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((cb: (...args: unknown[]) => void, ms?: number) => {
        waits.push(ms ?? 0);
        cb();
        return 0 as unknown as NodeJS.Timeout;
      });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result?.text).toBe("Extracted after retry");
    // The 86400s (24h) header must be clamped to 30s (30_000ms), not honored
    // verbatim — which would put this PDF read to sleep for a day.
    expect(waits).toEqual([30_000]);
    setTimeoutSpy.mockRestore();
  });

  it("clamps a negative Retry-After to zero instead of passing it through", async () => {
    // `Math.min(x, 30)` alone lets a negative header past — -3600 is finite, so
    // the "clamp" hands setTimeout -3_600_000. Harmless in effect today (the
    // timer floors at 0), but then the constant does not bound what it claims
    // to bound, and the next reader has to rediscover that.
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 429,
        headers: new Headers({ "retry-after": "-3600" }),
        text: async () => "Rate limited",
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          content: [{ type: "text", text: "Extracted after retry" }],
        }),
      });
    globalThis.fetch = mockFetch;

    const waits: number[] = [];
    const setTimeoutSpy = vi
      .spyOn(globalThis, "setTimeout")
      .mockImplementation((cb: (...args: unknown[]) => void, ms?: number) => {
        waits.push(ms ?? 0);
        cb();
        return 0 as unknown as NodeJS.Timeout;
      });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result?.text).toBe("Extracted after retry");
    expect(waits).toEqual([0]);
    setTimeoutSpy.mockRestore();
  });

  it("gives a local Ollama vision call a longer bound than a hosted one", async () => {
    // Ollama is the offline/self-hosted path: a cold start pays the model load
    // before decoding starts, and CPU-only inference on a full page runs into
    // minutes. Sharing the hosted bound here would abort exactly the
    // deployments the offline-first promise covers.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: "Local text" } }] }),
    });

    const result = await describePageImage("base64data", {
      model: "ollama/llama3.2-vision",
      resolveApiKey: async () => "unused",
      ollamaBaseUrl: "http://ollama:11434",
    });

    expect(result?.text).toBe("Local text");
    expect(timeoutSpy).toHaveBeenCalledWith(300_000);
    timeoutSpy.mockRestore();
  });

  it("bounds a hosted vision call well above a dense page's real decode time", async () => {
    // The bound exists to make a blackhole terminate, not to enforce a latency
    // budget. 4096 max_tokens of extracted text at typical decode rates is tens
    // of seconds, so a bound anywhere near that turns working page reads into
    // failures indistinguishable from a broken PDF.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout");
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ content: [{ type: "text", text: "Extracted" }] }),
    });

    await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    timeoutSpy.mockRestore();
  });

  it("aborts a hung vision API call via AbortSignal.timeout instead of blocking forever", async () => {
    // Simulates a vision provider that never answers and never resets the
    // connection (network blackhole) — the mock only ever settles via the
    // AbortSignal fetchWithRetry passes in, exactly like a real hung `fetch`
    // would once the signal fires.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
        1
      );
      return controller.signal;
    });
    globalThis.fetch = vi.fn((_url: RequestInfo | URL, init?: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new Error("The operation was aborted"));
        });
      });
    });

    await expect(
      describePageImage("base64data", {
        model: "anthropic/claude-haiku-4-5-20251001",
        resolveApiKey: async () => "test-key",
      })
    ).rejects.toThrow();

    expect(timeoutSpy).toHaveBeenCalledWith(120_000);
    timeoutSpy.mockRestore();
  });

  it("calls OpenAI API with image_url format", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "OpenAI extracted text" } }],
      }),
    });

    const result = await describePageImage("base64data", {
      model: "openai/gpt-4o",
      resolveApiKey: async () => "test-key",
    });

    expect(result?.text).toBe("OpenAI extracted text");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.openai.com/v1/chat/completions",
      expect.objectContaining({ method: "POST" })
    );
  });

  it("calls Google API with inline_data format", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Google extracted text" }] } }],
      }),
    });

    const result = await describePageImage("base64data", {
      model: "google/gemini-2.5-flash",
      resolveApiKey: async () => "test-key",
    });

    expect(result?.text).toBe("Google extracted text");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("generativelanguage.googleapis.com"),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("rejects invalid model IDs to prevent URL injection", async () => {
    await expect(
      describePageImage("base64data", {
        model: "google/../../admin",
        resolveApiKey: async () => "test-key",
      })
    ).rejects.toThrow("Invalid model ID");
  });

  describe("Ollama provider", () => {
    it("calls Ollama API with OpenAI-compatible format at configured base URL", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          choices: [{ message: { content: "Extracted text from scanned page" } }],
        }),
      });

      const result = await describePageImage("base64imagedata", {
        model: "ollama/llava:7b",
        ollamaBaseUrl: "http://localhost:11434",
        resolveApiKey: async () => null,
      });

      expect(result?.text).toBe("Extracted text from scanned page");
      expect(globalThis.fetch).toHaveBeenCalledWith(
        "http://localhost:11434/v1/chat/completions",
        expect.objectContaining({
          method: "POST",
          headers: expect.objectContaining({
            "content-type": "application/json",
          }),
        })
      );
      // Verify no Authorization header
      const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      const headers = (callArgs[1] as RequestInit).headers as Record<string, string>;
      expect(headers).not.toHaveProperty("authorization");
      expect(headers).not.toHaveProperty("Authorization");
    });

    it("returns null when ollamaBaseUrl is not configured", async () => {
      globalThis.fetch = vi.fn();

      const result = await describePageImage("base64data", {
        model: "ollama/llava:7b",
        resolveApiKey: async () => null,
      });
      expect(result).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });

    it("returns null on API error", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 500,
        text: async () => "Internal Server Error",
      });

      const result = await describePageImage("base64data", {
        model: "ollama/llava:7b",
        ollamaBaseUrl: "http://localhost:11434",
        resolveApiKey: async () => null,
      });
      expect(result).toBeNull();
    });

    it("does not handle ollama-cloud models", async () => {
      globalThis.fetch = vi.fn();

      const result = await describePageImage("base64data", {
        model: "ollama-cloud/gemini-3-flash-preview:cloud",
        ollamaBaseUrl: "http://localhost:11434",
        resolveApiKey: async () => null,
      });
      expect(result).toBeNull();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });
});

describe("describePageImage usage extraction", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("returns usage tokens from Anthropic response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "Extracted text" }],
        usage: { input_tokens: 1234, output_tokens: 56 },
      }),
    });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toEqual({
      text: "Extracted text",
      usage: { inputTokens: 1234, outputTokens: 56 },
    });
  });

  it("returns usage tokens from OpenAI response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "OpenAI text" } }],
        usage: { prompt_tokens: 900, completion_tokens: 42 },
      }),
    });

    const result = await describePageImage("base64data", {
      model: "openai/gpt-4o",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toEqual({
      text: "OpenAI text",
      usage: { inputTokens: 900, outputTokens: 42 },
    });
  });

  it("returns usage tokens from Google response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        candidates: [{ content: { parts: [{ text: "Google text" }] } }],
        usageMetadata: { promptTokenCount: 500, candidatesTokenCount: 70 },
      }),
    });

    const result = await describePageImage("base64data", {
      model: "google/gemini-2.5-flash",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toEqual({
      text: "Google text",
      usage: { inputTokens: 500, outputTokens: 70 },
    });
  });

  it("returns usage tokens from Ollama response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        choices: [{ message: { content: "Ollama text" } }],
        usage: { prompt_tokens: 300, completion_tokens: 20 },
      }),
    });

    const result = await describePageImage("base64data", {
      model: "ollama/llava:7b",
      ollamaBaseUrl: "http://localhost:11434",
      resolveApiKey: async () => null,
    });

    expect(result).toEqual({
      text: "Ollama text",
      usage: { inputTokens: 300, outputTokens: 20 },
    });
  });

  it("defaults usage to zero when provider omits usage field", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        content: [{ type: "text", text: "No usage provided" }],
        // no usage field
      }),
    });

    const result = await describePageImage("base64data", {
      model: "anthropic/claude-haiku-4-5-20251001",
      resolveApiKey: async () => "test-key",
    });

    expect(result).toEqual({
      text: "No usage provided",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
  });
});

describe("createVisionConfig", () => {
  it("extracts ollamaBaseUrl from config", () => {
    const config = createVisionConfig({
      modelAuth: { resolveApiKeyForProvider: async () => null },
      cfg: {
        models: {
          providers: {
            ollama: { baseUrl: "http://host.docker.internal:11434", api: "ollama" },
          },
        },
      },
      model: "ollama/llava:7b",
    });
    expect(config.ollamaBaseUrl).toBe("http://host.docker.internal:11434");
  });

  it("sets ollamaBaseUrl to undefined when no ollama provider configured", () => {
    const config = createVisionConfig({
      modelAuth: { resolveApiKeyForProvider: async () => null },
      cfg: {},
      model: "anthropic/claude-haiku-4-5-20251001",
    });
    expect(config.ollamaBaseUrl).toBeUndefined();
  });
});
