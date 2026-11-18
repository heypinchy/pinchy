// @vitest-environment node
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { braveSearch, resetBraveBaseUrlWarningForTest } from "./brave-search.js";

describe("braveSearch", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mockSuccessResponse(webResults: unknown[] = []) {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: webResults } }),
    });
  }

  it("makes a GET request to the Brave Search API with correct headers", async () => {
    mockSuccessResponse();

    await braveSearch("test query", { apiKey: "my-key" });

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toContain("https://api.search.brave.com/res/v1/web/search");
    expect(options.headers).toEqual(
      expect.objectContaining({
        "X-Subscription-Token": "my-key",
        Accept: "application/json",
      })
    );
  });

  it("sets query parameters correctly", async () => {
    mockSuccessResponse();

    await braveSearch("test query", {
      apiKey: "key",
      country: "US",
      language: "en",
      freshness: "pw",
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("test query");
    expect(url.searchParams.get("count")).toBe("5");
    expect(url.searchParams.get("extra_snippets")).toBe("true");
    expect(url.searchParams.get("country")).toBe("US");
    expect(url.searchParams.get("search_lang")).toBe("en");
    expect(url.searchParams.get("freshness")).toBe("pw");
  });

  it("injects a single allowed domain as site: filter", async () => {
    mockSuccessResponse();

    await braveSearch("original query", {
      apiKey: "key",
      allowedDomains: ["github.com"],
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("original query site:github.com");
  });

  it("injects multiple allowed domains with OR", async () => {
    mockSuccessResponse();

    await braveSearch("original query", {
      apiKey: "key",
      allowedDomains: ["a.com", "b.com"],
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("original query (site:a.com OR site:b.com)");
  });

  it("injects excluded domains as -site: filters", async () => {
    mockSuccessResponse();

    await braveSearch("original query", {
      apiKey: "key",
      excludedDomains: ["reddit.com", "pinterest.com"],
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("original query -site:reddit.com -site:pinterest.com");
  });

  it("combines allowed and excluded domains in the same query", async () => {
    mockSuccessResponse();

    await braveSearch("original query", {
      apiKey: "key",
      allowedDomains: ["github.com"],
      excludedDomains: ["reddit.com"],
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe("original query site:github.com -site:reddit.com");
  });

  it("rejects unsafe domain characters in allowedDomains (defence in depth)", async () => {
    await expect(
      braveSearch("q", { apiKey: "key", allowedDomains: ['evil.com") OR site:victim.com ("'] })
    ).rejects.toThrow(/invalid domain/i);
  });

  it("rejects unsafe domain characters in excludedDomains (defence in depth)", async () => {
    await expect(
      braveSearch("q", { apiKey: "key", excludedDomains: ["foo bar.com"] })
    ).rejects.toThrow(/invalid domain/i);
  });

  it("parses response into structured results", async () => {
    mockSuccessResponse([
      {
        title: "Result 1",
        url: "https://example.com/1",
        description: "First result",
        extra_snippets: ["snippet 1", "snippet 2"],
      },
      {
        title: "Result 2",
        url: "https://example.com/2",
        description: "Second result",
      },
    ]);

    const { results } = await braveSearch("query", { apiKey: "key" });

    expect(results).toEqual([
      {
        title: "Result 1",
        url: "https://example.com/1",
        description: "First result",
        extra_snippets: ["snippet 1", "snippet 2"],
      },
      {
        title: "Result 2",
        url: "https://example.com/2",
        description: "Second result",
        extra_snippets: undefined,
      },
    ]);
  });

  it("returns empty results when API returns no web results", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const { results } = await braveSearch("query", { apiKey: "key" });

    expect(results).toEqual([]);
  });

  it("throws a clear error on HTTP failure", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 429,
      text: async () => "Rate limit exceeded",
    });

    await expect(braveSearch("query", { apiKey: "key" })).rejects.toThrow(
      "Brave Search API error (429): Rate limit exceeded"
    );
  });

  it("carries the HTTP status on the thrown error (#1077)", async () => {
    // The plugin's auth classifier reads this status. Brave's own 401 body
    // (`{"code":"SUBSCRIPTION_TOKEN_INVALID"}`) contains no auth word, so
    // without the status a stale key would no longer trigger a refresh.
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => '{"code":"SUBSCRIPTION_TOKEN_INVALID"}',
    });

    const err = (await braveSearch("query", { apiKey: "key" }).catch((e: unknown) => e)) as {
      status?: number;
    };
    expect(err.status).toBe(401);
  });

  it("throws a descriptive error when API key is missing", async () => {
    await expect(braveSearch("query", { apiKey: "" })).rejects.toThrow(/API key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("aborts a hung Brave request via AbortSignal.timeout(30_000) instead of blocking forever", async () => {
    // Simulates a Brave endpoint that never answers and never resets the
    // connection (network blackhole) — the mock only ever settles via the
    // AbortSignal braveSearch passes to fetch, exactly like a real hung
    // `fetch` would once the signal fires.
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) => {
      const controller = new AbortController();
      setTimeout(
        () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
        1
      );
      return controller.signal;
    });
    fetchMock.mockImplementation((_url: string | URL, init?: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = init?.signal;
        signal?.addEventListener("abort", () => {
          reject(signal.reason ?? new Error("The operation was aborted"));
        });
      });
    });

    await expect(braveSearch("query", { apiKey: "key" })).rejects.toThrow();

    expect(timeoutSpy).toHaveBeenCalledWith(30_000);
    timeoutSpy.mockRestore();
  });

  describe("result-side domain post-filtering", () => {
    // The `site:` operator concatenated into the query above is only a
    // best-effort hint to Brave. The model controls the free-text part of the
    // query and can inject its own `site:`/`-site:` operators, whose
    // interaction with ours under multiple competing site: groups is
    // unspecified — so a result outside the configured domains can still come
    // back. These results are filtered by hostname before being handed to the
    // model, using the same allow/exclude semantics as pinchy_web_fetch.

    it("drops a result outside the allowed domains even though the query used site:", async () => {
      mockSuccessResponse([
        { title: "Good", url: "https://github.com/foo", description: "d1" },
        { title: "Bad", url: "https://evil.com/bar", description: "d2" },
      ]);

      const { results } = await braveSearch("original query", {
        apiKey: "key",
        allowedDomains: ["github.com"],
      });

      expect(results.map((r) => r.url)).toEqual(["https://github.com/foo"]);
    });

    it("drops a result from an excluded domain", async () => {
      mockSuccessResponse([
        { title: "Reddit", url: "https://reddit.com/r/foo", description: "d1" },
        { title: "Other", url: "https://example.com/bar", description: "d2" },
      ]);

      const { results } = await braveSearch("query", {
        apiKey: "key",
        excludedDomains: ["reddit.com"],
      });

      expect(results.map((r) => r.url)).toEqual(["https://example.com/bar"]);
    });

    it("keeps a result on a subdomain of an allowed domain", async () => {
      mockSuccessResponse([
        { title: "Sub", url: "https://docs.github.com/foo", description: "d1" },
      ]);

      const { results } = await braveSearch("query", {
        apiKey: "key",
        allowedDomains: ["github.com"],
      });

      expect(results.map((r) => r.url)).toEqual(["https://docs.github.com/foo"]);
    });

    it("drops a result whose URL cannot be parsed", async () => {
      mockSuccessResponse([
        { title: "Good", url: "https://github.com/foo", description: "d1" },
        { title: "Broken", url: "not a url", description: "d2" },
      ]);

      const { results, filteredCount } = await braveSearch("query", {
        apiKey: "key",
        allowedDomains: ["github.com"],
      });

      // An unverifiable URL is dropped rather than waved through — we cannot
      // say it is in scope, and "unknown" must not read as "allowed".
      expect(results.map((r) => r.url)).toEqual(["https://github.com/foo"]);
      expect(filteredCount).toBe(1);
    });

    it("drops a non-HTTP result URL that no exclude list could ever match", async () => {
      // `new URL("data:...").hostname` is the empty string, so an exclude-only
      // config matches nothing and would keep it — while pinchy_web_fetch
      // refuses the same URL on its scheme check. Both tools answer alike.
      mockSuccessResponse([
        { title: "Inline", url: "data:text/html,<h1>hi</h1>", description: "d1" },
        { title: "Fine", url: "https://example.com/ok", description: "d2" },
      ]);

      const { results, filteredCount } = await braveSearch("query", {
        apiKey: "key",
        excludedDomains: ["reddit.com"],
      });

      expect(results.map((r) => r.url)).toEqual(["https://example.com/ok"]);
      expect(filteredCount).toBe(1);
    });

    it("reports how many results were filtered out", async () => {
      mockSuccessResponse([
        { title: "Good", url: "https://github.com/foo", description: "d1" },
        { title: "Bad1", url: "https://evil.com/bar", description: "d2" },
        { title: "Bad2", url: "https://evil2.com/bar", description: "d3" },
      ]);

      const { filteredCount } = await braveSearch("query", {
        apiKey: "key",
        allowedDomains: ["github.com"],
      });

      expect(filteredCount).toBe(2);
    });

    it("leaves results and filteredCount untouched when no domain filters are configured", async () => {
      mockSuccessResponse([
        { title: "A", url: "https://any.com/1", description: "d1" },
        { title: "B", url: "https://other.com/2", description: "d2" },
      ]);

      const { results, filteredCount } = await braveSearch("query", { apiKey: "key" });

      expect(results).toHaveLength(2);
      expect(filteredCount).toBeUndefined();
    });
  });
});

describe("braveSearch mock env overrides", () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ web: { results: [] } }),
    });
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    resetBraveBaseUrlWarningForTest();
  });

  it("uses the real API host when BRAVE_API_BASE_URL is not set", async () => {
    await braveSearch("query", { apiKey: "key" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("https://api.search.brave.com/res/v1/web/search");
  });

  it("ignores BRAVE_API_BASE_URL and uses the real API host when PINCHY_INSECURE_WEB_MOCK is absent", async () => {
    vi.stubEnv("BRAVE_API_BASE_URL", "http://brave-mock:9003");
    // No PINCHY_INSECURE_WEB_MOCK: the mock seam must NOT fire, so a stray
    // override left over in production can't redirect the Brave API key.

    await braveSearch("query", { apiKey: "key" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("https://api.search.brave.com/res/v1/web/search");
  });

  it("uses BRAVE_API_BASE_URL when PINCHY_INSECURE_WEB_MOCK is also set", async () => {
    vi.stubEnv("BRAVE_API_BASE_URL", "http://brave-mock:9003");
    vi.stubEnv("PINCHY_INSECURE_WEB_MOCK", "1");

    await braveSearch("query", { apiKey: "key" });
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain("http://brave-mock:9003/res/v1/web/search");
  });

  it("warns exactly once when BRAVE_API_BASE_URL is set without the insecure flag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("BRAVE_API_BASE_URL", "http://brave-mock:9003");

    await braveSearch("query", { apiKey: "key" });
    await braveSearch("query", { apiKey: "key" });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("BRAVE_API_BASE_URL");
    expect(warn.mock.calls[0][0]).toContain("PINCHY_INSECURE_WEB_MOCK");
    warn.mockRestore();
  });

  it("does not warn when BRAVE_API_BASE_URL is set together with the insecure flag", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("BRAVE_API_BASE_URL", "http://brave-mock:9003");
    vi.stubEnv("PINCHY_INSECURE_WEB_MOCK", "1");

    await braveSearch("query", { apiKey: "key" });

    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
});
