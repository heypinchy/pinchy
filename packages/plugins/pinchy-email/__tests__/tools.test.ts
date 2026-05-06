import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock gmail-adapter before importing the plugin
const mockList = vi.fn();
const mockRead = vi.fn();
const mockSearch = vi.fn();
const mockDraft = vi.fn();
const mockSend = vi.fn();

vi.mock("../gmail-adapter", () => {
  const MockGmailAdapter = vi.fn(function (this: Record<string, unknown>) {
    this.list = mockList;
    this.read = mockRead;
    this.search = mockSearch;
    this.draft = mockDraft;
    this.send = mockSend;
  });
  return { GmailAdapter: MockGmailAdapter };
});

import { GmailAdapter } from "../gmail-adapter";
import plugin from "../index";

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<
    string,
    {
      connectionId: string;
      permissions: Record<string, string[]>;
    }
  >;
}

const testConfig: PluginConfig = {
  apiBaseUrl: "http://pinchy:7777",
  gatewayToken: "test-gateway-token",
  agents: {
    "agent-1": {
      connectionId: "conn-1",
      permissions: { email: ["read", "draft"] },
    },
  },
};

function createApi(pluginConfig: PluginConfig = testConfig) {
  const tools: Array<{
    factory: (ctx: { agentId?: string }) => AgentTool | null;
    name: string;
  }> = [];

  const api = {
    pluginConfig,
    registerTool: (
      factory: (ctx: { agentId?: string }) => AgentTool | null,
      opts?: { name?: string },
    ) => {
      tools.push({ factory, name: opts?.name ?? "" });
    },
  };

  plugin.register(api);
  return tools;
}

function findTool(
  tools: ReturnType<typeof createApi>,
  name: string,
  agentId?: string,
): AgentTool | null {
  const entry = tools.find((t) => t.name === name);
  if (!entry) return null;
  return entry.factory({ agentId });
}

const agentId = "agent-1";

// Mock global fetch for credential API calls
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockCredentialResponse(accessToken = "test-access-token") {
  mockFetch.mockResolvedValue({
    ok: true,
    json: async () => ({ type: "google", credentials: { accessToken } }),
  });
}

function mockCredentialFailure(
  status = 500,
  statusText = "Internal Server Error",
) {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    statusText,
  });
}

describe("tool registration", () => {
  it("registers all 5 tools", () => {
    const tools = createApi();
    expect(tools).toHaveLength(5);
    const names = tools.map((t) => t.name);
    expect(names).toContain("email_list");
    expect(names).toContain("email_read");
    expect(names).toContain("email_search");
    expect(names).toContain("email_draft");
    expect(names).toContain("email_send");
  });

  it("returns null for all tools when no agentId", () => {
    const tools = createApi();
    for (const tool of tools) {
      expect(tool.factory({})).toBeNull();
    }
  });

  it("returns null for all tools when agent has no config", () => {
    const tools = createApi();
    for (const tool of tools) {
      expect(tool.factory({ agentId: "unknown-agent" })).toBeNull();
    }
  });

  it("returns tool for agent with matching permission", () => {
    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId);
    expect(tool).not.toBeNull();
    expect(tool!.name).toBe("email_list");
  });

  it("returns tool even without specific permission (permission checked at execute time)", () => {
    // Agent has read+draft but not send — tool factory still returns the tool
    // because permission is checked at execution time, not registration time
    const tools = createApi();
    const tool = findTool(tools, "email_send", agentId);
    expect(tool).not.toBeNull();
  });
});

describe("permission checks at execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("email_send returns permission denied when agent lacks send permission", async () => {
    const tools = createApi();
    const tool = findTool(tools, "email_send", agentId)!;

    const result = await tool.execute("call-1", {
      to: "test@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it("email_draft returns permission denied when agent lacks draft permission", async () => {
    const configNoDraft: PluginConfig = {
      ...testConfig,
      agents: {
        "agent-1": {
          connectionId: "conn-1",
          permissions: { email: ["read"] },
        },
      },
    };
    const tools = createApi(configNoDraft);
    const tool = findTool(tools, "email_draft", agentId)!;

    const result = await tool.execute("call-1", {
      to: "test@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
  });
});

describe("credential fetching", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("caches credentials within TTL — second tool call reuses fetched token", async () => {
    mockCredentialResponse();
    mockList.mockResolvedValue([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", {});
    await tool.execute("call-2", {});

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockFetch).toHaveBeenCalledWith(
      "http://pinchy:7777/api/internal/integrations/conn-1/credentials",
      { headers: { Authorization: "Bearer test-gateway-token" } },
    );
  });

  it("refetches credentials after the TTL window expires", async () => {
    vi.useFakeTimers();
    try {
      mockCredentialResponse();
      mockList.mockResolvedValue([]);

      const tools = createApi();
      const tool = findTool(tools, "email_list", agentId)!;

      await tool.execute("call-1", {});
      // Advance well past 5min TTL
      vi.advanceTimersByTime(6 * 60 * 1000);
      await tool.execute("call-2", {});

      expect(mockFetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("creates GmailAdapter with fetched access token", async () => {
    mockCredentialResponse("fresh-token-123");
    mockList.mockResolvedValue([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", {});

    expect(GmailAdapter).toHaveBeenCalledWith({
      accessToken: "fresh-token-123",
    });
  });

  it("returns error when credential fetch fails", async () => {
    mockCredentialFailure(401, "Unauthorized");

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("credential");
    expect(result.isError).toBe(true);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("returns error when credential fetch throws network error", async () => {
    mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("ECONNREFUSED");
    expect(result.isError).toBe(true);
  });

  it("REGRESSION (#209): rejects SecretRef-shaped credentials with a clear hint, never reaching Gmail", async () => {
    // The credentials API returns the unresolved SecretRef object instead
    // of decrypted credentials (the bug shape from #209). The plugin must
    // reject this at the boundary instead of forwarding `undefined` as
    // accessToken to Gmail (which would produce a confusing 401).
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "google",
        credentials: {
          source: "file",
          provider: "pinchy",
          id: "/integrations/conn-1/accessToken",
        },
      }),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("must be a string");
    expect(text).toContain("#209");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("rejects credentials with missing accessToken", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ type: "google", credentials: {} }),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("accessToken");
    expect(mockList).not.toHaveBeenCalled();
  });

  it("invalidates cache and refetches when Gmail returns 401 (rotated/expired token)", async () => {
    // First call: cached token works
    mockCredentialResponse("stale-token");
    mockList.mockResolvedValueOnce([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    await tool.execute("call-1", {});
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Second call: Gmail responds 401 (token expired in the meantime),
    // plugin must invalidate cache, refetch, and retry once with the
    // fresh token from Pinchy.
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        type: "google",
        credentials: { accessToken: "fresh-token" },
      }),
    });
    mockList
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"))
      .mockResolvedValueOnce([]);

    const result = await tool.execute("call-2", {});

    expect(result.isError).toBeFalsy();
    expect(mockFetch).toHaveBeenCalledTimes(2);
    // call-1: 1 list call. call-2: 1 list call that rejects with 401, then
    // a retry list call after cache invalidation. Total = 3.
    expect(mockList).toHaveBeenCalledTimes(3);
    // Second GmailAdapter instantiation must use the fresh token
    expect(GmailAdapter).toHaveBeenLastCalledWith({ accessToken: "fresh-token" });
  });

  it("surfaces the auth error if the refetched token also fails", async () => {
    mockCredentialResponse();
    mockList
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"))
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("401");
    // Two fetches: initial + refetch after first 401
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(mockList).toHaveBeenCalledTimes(2);
  });
});

describe("email_list", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("lists emails with parameters", async () => {
    const emails = [
      {
        id: "msg-1",
        from: "a@test.com",
        subject: "Hello",
        snippet: "Hi there",
      },
    ];
    mockList.mockResolvedValue(emails);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {
      folder: "INBOX",
      limit: 10,
      unreadOnly: true,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(data[0].id).toBe("msg-1");
    expect(mockList).toHaveBeenCalledWith({
      folder: "INBOX",
      limit: 10,
      unreadOnly: true,
    });
  });
});

describe("email_read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("reads a single email by id", async () => {
    const email = {
      id: "msg-1",
      from: "a@test.com",
      subject: "Hello",
      body: "Full body",
    };
    mockRead.mockResolvedValue(email);

    const tools = createApi();
    const tool = findTool(tools, "email_read", agentId)!;

    const result = await tool.execute("call-1", { id: "msg-1" });

    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe("msg-1");
    expect(data.body).toBe("Full body");
    expect(mockRead).toHaveBeenCalledWith("msg-1");
  });
});

describe("email_search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("searches emails with query", async () => {
    const emails = [
      {
        id: "msg-2",
        from: "b@test.com",
        subject: "Invoice",
        snippet: "Please pay",
      },
    ];
    mockSearch.mockResolvedValue(emails);

    const tools = createApi();
    const tool = findTool(tools, "email_search", agentId)!;

    const result = await tool.execute("call-1", { query: "invoice", limit: 5 });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(mockSearch).toHaveBeenCalledWith({ query: "invoice", limit: 5 });
  });
});

describe("email_draft", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("creates a draft email", async () => {
    mockDraft.mockResolvedValue({ draftId: "draft-1" });

    const tools = createApi();
    const tool = findTool(tools, "email_draft", agentId)!;

    const result = await tool.execute("call-1", {
      to: "recipient@test.com",
      subject: "Draft Subject",
      body: "Draft body text",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.draftId).toBe("draft-1");
    expect(mockDraft).toHaveBeenCalledWith({
      to: "recipient@test.com",
      subject: "Draft Subject",
      body: "Draft body text",
      replyTo: undefined,
    });
  });

  it("creates a draft with replyTo", async () => {
    mockDraft.mockResolvedValue({ draftId: "draft-2" });

    const tools = createApi();
    const tool = findTool(tools, "email_draft", agentId)!;

    await tool.execute("call-1", {
      to: "recipient@test.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: "msg-1",
    });

    expect(mockDraft).toHaveBeenCalledWith({
      to: "recipient@test.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: "msg-1",
    });
  });
});

describe("email_send", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("sends an email when agent has send permission", async () => {
    mockSend.mockResolvedValue({ messageId: "sent-1" });

    const configWithSend: PluginConfig = {
      ...testConfig,
      agents: {
        "agent-1": {
          connectionId: "conn-1",
          permissions: { email: ["read", "draft", "send"] },
        },
      },
    };
    const tools = createApi(configWithSend);
    const tool = findTool(tools, "email_send", agentId)!;

    const result = await tool.execute("call-1", {
      to: "recipient@test.com",
      subject: "Sent Subject",
      body: "Sent body text",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.messageId).toBe("sent-1");
    expect(mockSend).toHaveBeenCalledWith({
      to: "recipient@test.com",
      subject: "Sent Subject",
      body: "Sent body text",
      replyTo: undefined,
    });
  });
});

describe("error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("returns error message when Gmail adapter throws", async () => {
    mockList.mockRejectedValue(new Error("Gmail API rate limit exceeded"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("Gmail API rate limit exceeded");
    expect(result.isError).toBe(true);
  });

  it("handles non-Error throws gracefully", async () => {
    mockList.mockRejectedValue("string error");

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.content[0].text).toContain("Unknown error");
    expect(result.isError).toBe(true);
  });
});
