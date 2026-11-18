// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  validateOpenAiCompatibleProvider,
  fetchOpenAiCompatibleModels,
  resolveCustomProviderModels,
  resetCustomModelCache,
  cachedCustomProviderModels,
  type CustomProviderModelSource,
} from "@/lib/openai-compatible-discovery";
import { DEFAULT_MODEL_CAPS } from "@/lib/model-catalog";
import { PROVIDER_PROBE_TIMEOUT_MS } from "@/lib/providers";
import { PROVIDER_DNS_LOOKUP_TIMEOUT_MS } from "@/lib/provider-url-guard";
import type { OpenClawModelDefinition } from "@/lib/openclaw-builtin-models";

global.fetch = vi.fn();

// The probe connects through `pinnedFetch` (real sockets, covered in
// pinned-connection.test.ts). Here it hands the request to the mocked global
// fetch, so the HTTP-behaviour tests below read the same, and records the
// address each request was pinned to — the half this file is about.
const { mockPinnedFetch } = vi.hoisted(() => ({ mockPinnedFetch: vi.fn() }));
vi.mock("@/lib/pinned-connection", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/pinned-connection")>()),
  pinnedFetch: mockPinnedFetch,
}));

// Every request goes through the SSRF guard, which resolves hostnames. No test
// here may touch real DNS: by default every name resolves to one public
// address, so tests about HTTP behaviour are unaffected. Tests about the guard
// give a name a different answer, or none.
const PUBLIC_ANSWER = "93.184.216.34";
const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));
vi.mock("dns/promises", () => ({ default: { lookup: mockLookup }, lookup: mockLookup }));

beforeEach(() => {
  mockLookup.mockReset();
  mockLookup.mockResolvedValue([{ address: PUBLIC_ANSWER, family: 4 }]);
  mockPinnedFetch.mockReset();
  mockPinnedFetch.mockImplementation((url: string, init: RequestInit) => fetch(url, init));
});

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
      keyVersion: "v1",
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

  // The slug never changes, but the endpoint behind it can. Keyed by slug
  // alone, the regenerate a re-pointing save triggers was served the OLD
  // endpoint's cached catalog and emitted it under the NEW base URL.
  describe("a cached list belongs to one destination and one key", () => {
    // A queued response a cache hit never consumed must not leak into the
    // next test (clearAllMocks keeps the once-queue).
    beforeEach(() => {
      vi.mocked(fetch).mockReset();
    });

    function listing(...ids: string[]) {
      return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), { status: 200 });
    }

    it("discovers afresh at the new endpoint when the provider is re-pointed", async () => {
      vi.mocked(fetch).mockImplementation(async (url) =>
        String(url).startsWith("https://acme.example.com/")
          ? listing("old-endpoint-model")
          : listing("new-endpoint-model")
      );

      const before = await resolveCustomProviderModels(source());
      expect(before.map((m) => m.id)).toEqual(["old-endpoint-model"]);

      vi.mocked(fetch).mockClear();
      const after = await resolveCustomProviderModels(
        source({ baseUrl: "https://new-host.example.com/v1", keyVersion: "v2" })
      );

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(String(vi.mocked(fetch).mock.calls[0]![0])).toBe(
        "https://new-host.example.com/v1/models"
      );
      expect(after.map((m) => m.id)).toEqual(["new-endpoint-model"]);
    });

    it("discovers afresh when only the path moved on the same origin", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(listing("account-a-model"));
      await resolveCustomProviderModels(source({ baseUrl: "https://gw.example.com/v1/a" }));

      vi.mocked(fetch).mockResolvedValueOnce(listing("account-b-model"));
      const after = await resolveCustomProviderModels(
        source({ baseUrl: "https://gw.example.com/v1/b" })
      );

      expect(after.map((m) => m.id)).toEqual(["account-b-model"]);
    });

    it("discovers afresh when a new key was entered at the same address", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(listing("old-key-model"));
      await resolveCustomProviderModels(source());

      vi.mocked(fetch).mockResolvedValueOnce(listing("new-key-model"));
      const after = await resolveCustomProviderModels(source({ keyVersion: "v2" }));

      expect(after.map((m) => m.id)).toEqual(["new-key-model"]);
    });

    it("still hits the cache for the same destination written with a trailing slash or upper-case host", async () => {
      vi.mocked(fetch).mockResolvedValueOnce(listing("acme-large"));
      await resolveCustomProviderModels(source());

      vi.mocked(fetch).mockClear();
      const again = await resolveCustomProviderModels(
        source({ baseUrl: "https://ACME.example.com/v1/" })
      );

      expect(fetch).not.toHaveBeenCalled();
      expect(again.map((m) => m.id)).toEqual(["acme-large"]);
    });
  });
});

describe("cachedCustomProviderModels", () => {
  // A provider whose base URL is refused is never fetched, but its emitted
  // block must not shrink to the saved snapshot (see build.ts). The last live
  // list is the next-best size, and reading it must not touch the network.
  beforeEach(() => {
    vi.clearAllMocks();
    resetCustomModelCache();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("is undefined when no live list was ever fetched", () => {
    expect(cachedCustomProviderModels("acme")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns the last live list, even after the TTL, without fetching", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "acme-large" }, { id: "acme-small" }] }), {
        status: 200,
      })
    );
    await resolveCustomProviderModels({
      slug: "acme",
      baseUrl: "https://acme.example.com/v1",
      apiKey: "sk-key",
      keyVersion: "0123456789abcdef",
      models: [],
    });
    vi.mocked(fetch).mockClear();
    vi.setSystemTime(Date.now() + 2 * 60 * 60 * 1000);

    expect(cachedCustomProviderModels("acme")?.map((m) => m.id)).toEqual([
      "acme-large",
      "acme-small",
    ]);
    expect(cachedCustomProviderModels("beta")).toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
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

/**
 * The saved base URL is checked again every time Pinchy fetches it — not only
 * when an admin saves it.
 *
 * The discover/save routes validate the URL, but the stored value is then read
 * back on every `regenerateOpenClawConfig()` and every model-list fetch, both
 * of which call in here. A provider saved under older rules, or before
 * `PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS` was set, kept being fetched — with
 * its API key attached. Same contract as the stored Odoo URL / mail host
 * (lib/integrations/stored-destination.ts).
 */
describe("fetchModels — the stored base URL itself is re-validated", () => {
  const snapshot: OpenClawModelDefinition[] = [
    { ...DEFAULT_MODEL_CAPS, id: "acme-snapshot", name: "Acme Snapshot" },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    resetCustomModelCache();
    // A fresh Response per call: a body can be read only once.
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ data: [{ id: "acme-large" }] }), { status: 200 })
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each([
    ["the cloud metadata literal", "http://169.254.169.254/v1"],
    ["an IPv6 loopback literal", "http://[::1]:8000/v1"],
    ["Alibaba Cloud metadata inside CGNAT", "http://100.100.100.200/v1"],
  ])("never requests %s", async (_label, baseUrl) => {
    const models = await fetchOpenAiCompatibleModels(baseUrl, "sk-key");

    expect(models).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("never requests a name that now resolves to a metadata address", async () => {
    mockLookup.mockResolvedValue([{ address: "169.254.169.254", family: 4 }]);

    const models = await fetchOpenAiCompatibleModels("https://llm.acme.example/v1", "sk-key");

    expect(models).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a refused base URL as unreachable, not as a bad key", async () => {
    const result = await validateOpenAiCompatibleProvider("http://169.254.169.254/v1", "sk-key");

    expect(result).toEqual({ valid: false, error: "network_error" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back to the saved snapshot instead of fetching a refused saved provider", async () => {
    const models = await resolveCustomProviderModels({
      slug: "acme",
      baseUrl: "http://169.254.169.254/v1",
      apiKey: "sk-key",
      keyVersion: "0123456789abcdef",
      models: snapshot,
    });

    expect(models).toEqual(snapshot);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("honours PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS for a provider saved before it was set", async () => {
    vi.stubEnv("PINCHY_PROVIDER_BLOCK_PRIVATE_NETWORKS", "1");
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);

    const models = await resolveCustomProviderModels({
      slug: "lan",
      baseUrl: "http://vllm.lan.example:8000/v1",
      apiKey: "sk-key",
      keyVersion: "0123456789abcdef",
      models: snapshot,
    });

    expect(models).toEqual(snapshot);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("still fetches a LAN endpoint by default, and a public one", async () => {
    mockLookup.mockResolvedValue([{ address: "10.0.0.5", family: 4 }]);
    const lan = await fetchOpenAiCompatibleModels("http://vllm.lan.example:8000/v1", "sk-key");
    expect(lan.map((m) => m.id)).toEqual(["acme-large"]);

    mockLookup.mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
    const pub = await fetchOpenAiCompatibleModels("https://llm.acme.example/v1", "sk-key");
    expect(pub.map((m) => m.id)).toEqual(["acme-large"]);

    expect(fetch).toHaveBeenCalledTimes(2);
  });
});

describe("fetchModels — the guard's DNS lookup is inside the probe's time budget", () => {
  // The guard resolves the host before every hop. Its lookup used to run
  // before the hop's timeout started, so a resolver that never answered held
  // the probe — and with it a settings save or a config regenerate — forever.
  afterEach(() => {
    vi.useRealTimers();
  });

  /** A fetch that only ever ends by its signal aborting, like a silent host. */
  function fetchThatWaitsForAbort() {
    vi.mocked(fetch).mockImplementation(
      (_url, init) =>
        new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })
    );
  }

  it("gives up without a request once the lookup budget is spent", async () => {
    // It used to go ahead (fail open), and the request then resolved the name
    // a second time — a resolver that stalled the check could answer the
    // connect with anything. There is one lookup now, and no answer means
    // no request.
    vi.useFakeTimers();
    mockLookup.mockImplementation(() => new Promise(() => {}));
    vi.mocked(fetch).mockResolvedValue(new Response("{}", { status: 200 }));

    const result = validateOpenAiCompatibleProvider("https://api.example.com/v1", "sk-key");
    await vi.advanceTimersByTimeAsync(PROVIDER_DNS_LOOKUP_TIMEOUT_MS);

    expect(await result).toEqual({ valid: false, error: "network_error" });
    expect(mockPinnedFetch).not.toHaveBeenCalled();
  });

  it("ends the whole hop — lookup and request together — within PROVIDER_PROBE_TIMEOUT_MS", async () => {
    vi.useFakeTimers();
    mockLookup.mockImplementation(() => new Promise(() => {}));
    fetchThatWaitsForAbort();

    let settled: unknown = "still waiting";
    void validateOpenAiCompatibleProvider("https://api.example.com/v1", "sk-key").then(
      (r) => (settled = r)
    );
    await vi.advanceTimersByTimeAsync(PROVIDER_PROBE_TIMEOUT_MS);

    expect(settled).toEqual({ valid: false, error: "network_error" });
  });
});

describe("fetchModels — the request goes to the address the guard classified", () => {
  // DNS rebinding: the guard resolved the name, liked the answer, and the
  // request then resolved it AGAIN — so a resolver that answers a public
  // address first and 127.0.0.1 second walked straight past the check.
  beforeEach(() => {
    vi.clearAllMocks();
    resetCustomModelCache();
    vi.mocked(fetch).mockImplementation(
      async () => new Response(JSON.stringify({ data: [{ id: "acme-large" }] }), { status: 200 })
    );
  });

  it("pins the request to the checked answer, not to a second one", async () => {
    mockLookup
      .mockResolvedValueOnce([{ address: PUBLIC_ANSWER, family: 4 }])
      .mockResolvedValue([{ address: "127.0.0.1", family: 4 }]);

    await fetchOpenAiCompatibleModels("https://rebind.acme.example/v1", "sk-key");

    expect(mockPinnedFetch).toHaveBeenCalledTimes(1);
    expect(mockPinnedFetch).toHaveBeenCalledWith(
      "https://rebind.acme.example/v1/models",
      expect.anything(),
      [{ address: PUBLIC_ANSWER, family: 4 }]
    );
    // One resolution per hop: the one that was classified.
    expect(mockLookup).toHaveBeenCalledTimes(1);
  });

  it("pins an IPv6 answer with its family", async () => {
    mockLookup.mockResolvedValue([{ address: "2606:2800:220:1::1", family: 6 }]);

    await fetchOpenAiCompatibleModels("https://v6.acme.example/v1", "sk-key");

    expect(mockPinnedFetch).toHaveBeenCalledWith(expect.any(String), expect.anything(), [
      { address: "2606:2800:220:1::1", family: 6 },
    ]);
  });

  it("pins every checked answer of a dual-stack name, so the connect can fall back", async () => {
    mockLookup.mockResolvedValue([
      { address: "2606:2800:220:1::1", family: 6 },
      { address: PUBLIC_ANSWER, family: 4 },
    ]);

    await fetchOpenAiCompatibleModels("https://dual.acme.example/v1", "sk-key");

    expect(mockPinnedFetch).toHaveBeenCalledWith(expect.any(String), expect.anything(), [
      { address: "2606:2800:220:1::1", family: 6 },
      { address: PUBLIC_ANSWER, family: 4 },
    ]);
  });

  it("pins an address literal to itself, without a lookup", async () => {
    await fetchOpenAiCompatibleModels("http://10.0.0.5:8000/v1", "sk-key");

    expect(mockLookup).not.toHaveBeenCalled();
    expect(mockPinnedFetch).toHaveBeenCalledWith(expect.any(String), expect.anything(), [
      { address: "10.0.0.5", family: 4 },
    ]);
  });

  it("never requests a name whose lookup failed", async () => {
    // The guard used to let an unresolvable name through, and the request's
    // own lookup was then free to answer 127.0.0.1.
    mockLookup.mockRejectedValue(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));

    const result = await validateOpenAiCompatibleProvider(
      "https://flaky.acme.example/v1",
      "sk-key"
    );

    expect(result).toEqual({ valid: false, error: "network_error" });
    expect(mockPinnedFetch).not.toHaveBeenCalled();
  });

  it("pins every redirect hop to that hop's own checked answer", async () => {
    mockLookup.mockImplementation(async (host: string) =>
      host === "api.acme.example"
        ? [{ address: PUBLIC_ANSWER, family: 4 }]
        : [{ address: "93.184.216.35", family: 4 }]
    );
    vi.mocked(fetch)
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: "https://cdn.acme.example/v1/models" },
        })
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "acme-large" }] }), { status: 200 })
      );

    await fetchOpenAiCompatibleModels("https://api.acme.example/v1", "sk-key");

    expect(mockPinnedFetch.mock.calls.map((call) => [call[0], call[2]])).toEqual([
      ["https://api.acme.example/v1/models", [{ address: PUBLIC_ANSWER, family: 4 }]],
      ["https://cdn.acme.example/v1/models", [{ address: "93.184.216.35", family: 4 }]],
    ]);
  });
});
