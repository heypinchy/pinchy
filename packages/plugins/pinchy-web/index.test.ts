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
      signal?: AbortSignal,
    ) => Promise<{ content: { type: string; text: string }[]; isError?: boolean }>;
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
  const fetchMock = vi.fn(async () => ({
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
        }),
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

    it("passes excludedDomains from agent config", async () => {
      braveSearchMock.mockResolvedValue({ results: [] });
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": {
            tools: ["pinchy_web_search"],
            excludedDomains: ["reddit.com", "pinterest.com"],
          },
        }),
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      await tool.execute("call-1", { query: "some query" });

      expect(braveSearchMock).toHaveBeenCalledWith("some query", expect.objectContaining({
        excludedDomains: ["reddit.com", "pinterest.com"],
      }));
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
    });

    it("returns isError when braveSearch throws", async () => {
      braveSearchMock.mockRejectedValue(new Error("API rate limit"));
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        }),
      );

      const tool = factories.pinchy_web_search({ agentId: "agent-1" })!;
      const result = await tool.execute("call-1", { query: "test" });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("Search failed");
      expect(result.content[0].text).toContain("API rate limit");
    });

    it("handles non-Error throws from braveSearch", async () => {
      braveSearchMock.mockRejectedValue("string error");
      stubCredentialsFetch("brave-key-123");

      const factories = collectFactories(
        credentialsPluginConfig({
          "agent-1": { tools: ["pinchy_web_search"] },
        }),
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
});
