// @vitest-environment jsdom
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

/**
 * A redirect is a new destination, and the SSRF guard has to see it.
 *
 * The two routes that reach this module validate the admin's `baseUrl` before
 * calling in — and then `fetchModels` used the default `redirect: "follow"`,
 * so a host that passed the guard could answer `302 Location:
 * http://169.254.169.254/` and undici would follow it, carrying the
 * Authorization header. The guard's verdict applied to a URL the request
 * never ended at.
 *
 * No mock of the guard here on purpose: these use IP literals, which it
 * classifies without touching DNS, so what is asserted is the real thing.
 */
describe("fetchModels — redirects are re-validated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetCustomModelCache();
  });

  function redirectTo(location: string, status = 302) {
    return new Response(null, { status, headers: { location } });
  }

  const modelBody = () =>
    new Response(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }), { status: 200 });

  it("requests with redirect: manual rather than letting undici follow", async () => {
    vi.mocked(fetch).mockResolvedValue(modelBody());

    await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(fetch).toHaveBeenCalledWith(
      "https://api.example.com/v1/models",
      expect.objectContaining({ redirect: "manual" })
    );
  });

  /**
   * Asserted as a CONTRAST, and that is the point: a mocked `fetch` never
   * follows a redirect by itself, so "we returned []" holds whether the guard
   * runs or not — those assertions would stay green against the vulnerable
   * code. What actually separates the two worlds is whether the hop gets
   * REQUESTED. A permitted target produces a second call; a blocked one must
   * not. Delete the `assertAllowedProviderUrl` call and the blocked rows
   * below make two calls and fail.
   */
  it.each([
    ["the cloud metadata address", "http://169.254.169.254/latest/meta-data/", 1],
    // The form that bypassed the guard entirely until the hostname was
    // de-bracketed before classification.
    ["loopback as an IPv6 literal", "http://[::1]/v1/models", 1],
    ["IMDS through an IPv4-mapped IPv6 literal", "http://[::ffff:169.254.169.254]/", 1],
    // Protocol-relative: changes host without looking like an absolute URL.
    ["a protocol-relative hop to a blocked host", "//169.254.169.254/latest/", 1],
    ["an ordinary public host", "https://93.184.216.34/v2/models", 2],
  ])("redirect to %s is requested %s time(s) in total", async (_label, location, expectedCalls) => {
    vi.mocked(fetch).mockResolvedValueOnce(redirectTo(location)).mockResolvedValue(modelBody());

    await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(fetch).toHaveBeenCalledTimes(expectedCalls);
  });

  it("reports a blocked redirect as an unreachable provider, not a bad key", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(redirectTo("http://169.254.169.254/"));

    const result = await validateOpenAiCompatibleProvider("https://api.example.com/v1", "sk-key");

    expect(result).toEqual({ valid: false, error: "network_error" });
  });

  it("still follows an ordinary redirect to a public host", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(redirectTo("https://93.184.216.34/v2/models"))
      .mockResolvedValueOnce(modelBody());

    const models = await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(models.map((m) => m.id)).toEqual(["gpt-4o-mini"]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("https://93.184.216.34/v2/models");
  });

  it("resolves a relative Location against the URL actually requested", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(redirectTo("/v2/models"))
      .mockResolvedValueOnce(modelBody());

    await fetchOpenAiCompatibleModels("https://93.184.216.34/v1", "sk-key");

    expect(vi.mocked(fetch).mock.calls[1][0]).toBe("https://93.184.216.34/v2/models");
  });

  it("gives up rather than looping on an endless redirect chain", async () => {
    vi.mocked(fetch).mockResolvedValue(redirectTo("https://93.184.216.34/again"));

    const models = await fetchOpenAiCompatibleModels("https://93.184.216.34/v1", "sk-key");

    expect(models).toEqual([]);
    // Initial request + MAX_REDIRECT_HOPS follows, then it stops.
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("treats a redirect status with no Location as an ordinary non-2xx", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(new Response(null, { status: 302 }));

    const models = await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-key");

    expect(models).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  /**
   * Following redirects by hand means owning what the platform used to do.
   *
   * `redirect: "follow"` is not a plain "go there": the fetch spec strips
   * `Authorization` when a redirect crosses an origin, precisely so a
   * redirecting server cannot harvest a credential meant for itself. Taking
   * the loop over and re-sending the same headers hands the provider API key
   * to whatever host the `Location` names — and the SSRF guard is no help
   * here, because an attacker's collector is an ordinary public address it is
   * right to allow.
   *
   * Same origin keeps the header, or every provider that redirects
   * `/v1/models` to `/v1/models/` would stop authenticating.
   */
  describe("credentials across a redirect", () => {
    function authHeaderOfCall(index: number): string | undefined {
      const init = vi.mocked(fetch).mock.calls[index][1] as { headers: Record<string, string> };
      return init.headers.Authorization;
    }

    it("does not carry the API key to a different origin", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(redirectTo("https://93.184.216.34/harvest"))
        .mockResolvedValueOnce(modelBody());

      await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-secret");

      expect(authHeaderOfCall(0)).toBe("Bearer sk-secret");
      expect(authHeaderOfCall(1)).toBeUndefined();
    });

    it("does not carry it to a different port or scheme on the same host either", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(redirectTo("http://api.example.com:8080/v1/models"))
        .mockResolvedValueOnce(modelBody());

      await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-secret");

      expect(authHeaderOfCall(1)).toBeUndefined();
    });

    it("keeps it on a same-origin redirect", async () => {
      vi.mocked(fetch)
        .mockResolvedValueOnce(redirectTo("/v1/models/"))
        .mockResolvedValueOnce(modelBody());

      await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-secret");

      expect(authHeaderOfCall(1)).toBe("Bearer sk-secret");
    });

    it("never regains it after a hop back to the original origin", async () => {
      // The spec strips on the first cross-origin hop and does not restore the
      // header afterwards — a redirect chain must not be a way to launder one.
      vi.mocked(fetch)
        .mockResolvedValueOnce(redirectTo("https://93.184.216.34/hop"))
        .mockResolvedValueOnce(redirectTo("https://api.example.com/v1/models"))
        .mockResolvedValueOnce(modelBody());

      await fetchOpenAiCompatibleModels("https://api.example.com/v1", "sk-secret");

      expect(authHeaderOfCall(2)).toBeUndefined();
    });
  });
});
