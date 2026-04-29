import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { braveSearch } from "./brave-search.js";

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
      }),
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
    expect(url.searchParams.get("q")).toBe(
      "original query (site:a.com OR site:b.com)",
    );
  });

  it("injects excluded domains as -site: filters", async () => {
    mockSuccessResponse();

    await braveSearch("original query", {
      apiKey: "key",
      excludedDomains: ["reddit.com", "pinterest.com"],
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe(
      "original query -site:reddit.com -site:pinterest.com",
    );
  });

  it("combines allowed and excluded domains in the same query", async () => {
    mockSuccessResponse();

    await braveSearch("original query", {
      apiKey: "key",
      allowedDomains: ["github.com"],
      excludedDomains: ["reddit.com"],
    });

    const url = new URL(fetchMock.mock.calls[0][0]);
    expect(url.searchParams.get("q")).toBe(
      "original query site:github.com -site:reddit.com",
    );
  });

  it("rejects unsafe domain characters in allowedDomains (defence in depth)", async () => {
    await expect(
      braveSearch("q", { apiKey: "key", allowedDomains: ['evil.com") OR site:victim.com ("'] }),
    ).rejects.toThrow(/invalid domain/i);
  });

  it("rejects unsafe domain characters in excludedDomains (defence in depth)", async () => {
    await expect(
      braveSearch("q", { apiKey: "key", excludedDomains: ["foo bar.com"] }),
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
      "Brave Search API error (429): Rate limit exceeded",
    );
  });

  it("throws a descriptive error when API key is missing", async () => {
    await expect(braveSearch("query", { apiKey: "" })).rejects.toThrow(
      /API key/i,
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
