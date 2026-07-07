// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock gmail-adapter before importing the plugin
const mockList = vi.fn();
const mockRead = vi.fn();
const mockSearch = vi.fn();
const mockDraft = vi.fn();
const mockSend = vi.fn();
const mockGetAttachment = vi.fn();

vi.mock("../gmail-adapter", () => {
  const MockGmailAdapter = vi.fn(function (this: Record<string, unknown>) {
    this.list = mockList;
    this.read = mockRead;
    this.search = mockSearch;
    this.draft = mockDraft;
    this.send = mockSend;
    this.getAttachment = mockGetAttachment;
  });
  return { GmailAdapter: MockGmailAdapter };
});

vi.mock("../graph-adapter", () => {
  const MockGraphAdapter = vi.fn(function (this: Record<string, unknown>) {
    this.list = mockList;
    this.read = mockRead;
    this.search = mockSearch;
    this.draft = mockDraft;
    this.send = mockSend;
    this.getAttachment = mockGetAttachment;
  });
  return { GraphAdapter: MockGraphAdapter };
});

// Mock node:fs/promises so attachment writes never touch the real filesystem.
// vi.mock(...) is hoisted above these const declarations, so the mock fns
// themselves must be created via vi.hoisted() to avoid a TDZ error.
const { mockMkdir, mockWriteFile, mockAccess } = vi.hoisted(() => ({
  mockMkdir: vi.fn(),
  mockWriteFile: vi.fn(),
  mockAccess: vi.fn(),
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mockMkdir,
  writeFile: mockWriteFile,
  access: mockAccess,
}));

import { GmailAdapter } from "../gmail-adapter";
import { GraphAdapter } from "../graph-adapter";
import plugin from "../index";
import {
  MAX_ENTRIES_PER_AGENT,
  MSG_PREFIX,
  resolveHandle,
} from "../id-handle-store";

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
    details?: unknown;
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
  it("registers all 6 tools", () => {
    const tools = createApi();
    expect(tools).toHaveLength(6);
    const names = tools.map((t) => t.name);
    expect(names).toContain("email_list");
    expect(names).toContain("email_read");
    expect(names).toContain("email_search");
    expect(names).toContain("email_draft");
    expect(names).toContain("email_send");
    expect(names).toContain("email_get_attachment");
  });

  it("returns a non-null stub for all tools when no agentId (OC probe call)", async () => {
    // When OpenClaw calls the factory without session context (e.g. at registerTool()
    // time during hot-reload), returning null would permanently unregister the tool.
    // We return a minimal stub so OC keeps the tool in its registry; the real
    // session-time factory call (with agentId) supersedes it.
    const tools = createApi();
    for (const tool of tools) {
      const stub = tool.factory({});
      expect(stub).not.toBeNull();
      expect(stub!.name).toBe(tool.name);
      // Stub execute() must fail fast rather than call external services
      const result = await stub!.execute("call-probe", {});
      expect(result.isError).toBe(true);
      // The stub is an error-returning path too, so it must carry a non-empty
      // details.error — on staging OpenClaw strips isError and the audit route
      // only counts non-empty details.error strings as a failure (issue #404).
      const details = result.details as { error?: string } | undefined;
      expect(details?.error).toBeTruthy();
      expect(details?.error).toBe(result.content[0].text);
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

// MIGRATION TESTS (AGENTS.md § "Test Migrations Against Pre-Existing Data"):
// pre-Pinchy-#328 agent template creation could persist a standalone
// (model="email", operation="search") permission row with NO accompanying
// "read" row. build.ts passes DB permission rows through into the plugin
// config's `permissions` object unchanged, so a stale config not yet
// regenerated after upgrading to #328 can still carry exactly
// `{ email: ["search"] }`. Exercise that legacy shape at the tool-execution
// layer (not just the permissions.ts unit), so a regression here is caught
// even if someone changes how index.ts calls checkPermission.
describe("legacy 'search'-only permissions (pre-#328 rows without a 'read' row)", () => {
  const legacySearchOnlyConfig: PluginConfig = {
    ...testConfig,
    agents: {
      "agent-1": {
        connectionId: "conn-1",
        permissions: { email: ["search"] },
      },
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("email_list executes (read-gated) for a legacy search-only grant", async () => {
    mockList.mockResolvedValue([]);
    const tools = createApi(legacySearchOnlyConfig);
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBeUndefined();
    expect(mockList).toHaveBeenCalled();
  });

  it("email_read executes (read-gated) for a legacy search-only grant", async () => {
    mockRead.mockResolvedValue({
      id: "msg-1",
      from: "a@test.com",
      subject: "Hi",
      body: "body",
    });
    const tools = createApi(legacySearchOnlyConfig);
    const tool = findTool(tools, "email_read", agentId)!;

    const result = await tool.execute("call-1", { id: "msg-1" });

    expect(result.isError).toBeUndefined();
    expect(mockRead).toHaveBeenCalledWith("msg-1");
  });

  it("email_search executes (read-gated) for a legacy search-only grant", async () => {
    mockSearch.mockResolvedValue([]);
    const tools = createApi(legacySearchOnlyConfig);
    const tool = findTool(tools, "email_search", agentId)!;

    const result = await tool.execute("call-1", { subject: "Hi" });

    expect(result.isError).toBeUndefined();
    expect(mockSearch).toHaveBeenCalled();
  });

  it("email_get_attachment executes (read-gated) for a legacy search-only grant", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "file.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello"),
    });
    mockMkdir.mockResolvedValue(undefined);
    mockAccess.mockRejectedValue(new Error("ENOENT"));
    mockWriteFile.mockResolvedValue(undefined);

    const tools = createApi(legacySearchOnlyConfig);
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBeUndefined();
    expect(mockGetAttachment).toHaveBeenCalledWith("msg-1", "att-1");
  });

  it("email_draft still returns permission denied for a legacy search-only grant (search must not unlock draft)", async () => {
    const tools = createApi(legacySearchOnlyConfig);
    const tool = findTool(tools, "email_draft", agentId)!;

    const result = await tool.execute("call-1", {
      to: "test@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
  });

  it("email_send still returns permission denied for a legacy search-only grant (search must not unlock send)", async () => {
    const tools = createApi(legacySearchOnlyConfig);
    const tool = findTool(tools, "email_send", agentId)!;

    const result = await tool.execute("call-1", {
      to: "test@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
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

  it("dispatches to GmailAdapter when credentials.type is 'google'", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "google",
        credentials: { accessToken: "google-token" },
      }),
    });
    mockList.mockResolvedValue([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", {});

    expect(GmailAdapter).toHaveBeenCalledWith({ accessToken: "google-token" });
  });

  it("dispatches to GraphAdapter when credentials.type is 'microsoft'", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        type: "microsoft",
        credentials: { accessToken: "ms-tok" },
      }),
    });
    mockList.mockResolvedValue([]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBeFalsy();
    expect(GraphAdapter).toHaveBeenCalledWith({ accessToken: "ms-tok" });
    expect(GmailAdapter).not.toHaveBeenCalled();
    expect(mockList).toHaveBeenCalledTimes(1);
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

  it("throws a clear error when credentials API returns no type field", async () => {
    mockFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ credentials: { accessToken: "tok" } }),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "credentials API returned no type field",
    );
    expect(mockList).not.toHaveBeenCalled();
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
    expect(GmailAdapter).toHaveBeenLastCalledWith({
      accessToken: "fresh-token",
    });
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
    // Two credential fetches: initial + refetch after first 401.
    // A third fetch goes to report-auth-failure (best-effort).
    const credentialFetches = mockFetch.mock.calls.filter(
      (c) => !String(c[0]).includes("report-auth-failure"),
    );
    expect(credentialFetches).toHaveLength(2);
    expect(mockList).toHaveBeenCalledTimes(2);
  });

  it("POSTs report-auth-failure when retry-once also returns an auth error", async () => {
    mockCredentialResponse();
    mockList
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"))
      .mockRejectedValueOnce(new Error("HTTP 401: Invalid Credentials"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    await tool.execute("call-1", {});

    const reportCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("report-auth-failure"),
    );
    expect(reportCalls).toHaveLength(1);
    const [url, opts] = reportCalls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://pinchy:7777/api/internal/integrations/conn-1/report-auth-failure",
    );
    expect(opts.method).toBe("POST");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-gateway-token");
    expect(headers["X-Plugin-Id"]).toBe("pinchy-email");
    const body = JSON.parse(opts.body as string) as { reason: string };
    expect(body.reason).toBeTruthy();
  });

  it("does not POST report-auth-failure on a transient 5xx error", async () => {
    mockCredentialResponse();
    mockList.mockRejectedValueOnce(new Error("HTTP 503 Service Unavailable"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    await tool.execute("call-1", {});

    const reportCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("report-auth-failure"),
    );
    expect(reportCalls).toHaveLength(0);
  });

  // REGRESSION (B3+B7): the credentials route can answer 503 instead of a
  // 200-with-stale-tokens when the OAuth app settings are gone (see
  // OAuthSettingsMissingError in the credentials route). That 503 body
  // carries an actionable remediation message — it must reach the agent,
  // and the connection must be flagged auth_failed so the admin re-authorize
  // banner appears, exactly as it would for a provider-side 401.
  it("surfaces the 503 body's remediation message instead of a generic 'Failed to fetch credentials'", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({
        error:
          "Microsoft OAuth settings missing — reconnect the mailbox or restore the OAuth app",
      }),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "Microsoft OAuth settings missing — reconnect the mailbox or restore the OAuth app",
    );
    expect(mockList).not.toHaveBeenCalled();
  });

  it("reports the connection as auth-failed when the credentials fetch itself 503s (settings-missing case)", async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: "Service Unavailable",
      json: async () => ({
        error:
          "Microsoft OAuth settings missing — reconnect the mailbox or restore the OAuth app",
      }),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    await tool.execute("call-1", {});

    const reportCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("report-auth-failure"),
    );
    expect(reportCalls).toHaveLength(1);
    const [url, opts] = reportCalls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://pinchy:7777/api/internal/integrations/conn-1/report-auth-failure",
    );
    expect(opts.method).toBe("POST");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-gateway-token");
    expect(headers["X-Plugin-Id"]).toBe("pinchy-email");
    const body = JSON.parse(opts.body as string) as { reason: string };
    expect(body.reason).toContain("OAuth settings missing");
  });

  it("does NOT report auth-failure for a plain 500 credentials-fetch error (no settings-missing semantics)", async () => {
    mockCredentialFailure(500, "Internal Server Error");

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;
    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    const reportCalls = mockFetch.mock.calls.filter((c) =>
      String(c[0]).includes("report-auth-failure"),
    );
    expect(reportCalls).toHaveLength(0);
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
    expect(mockList).toHaveBeenCalledWith({
      folder: "INBOX",
      limit: 10,
      unreadOnly: true,
    });
  });

  // Handle-indirection (Bug B, 2026-07-07 debugging session; sibling of
  // PR #668): the model must never see the raw provider id — it must see a
  // short, stable handle instead, so it can't corrupt a ~150-char Graph blob
  // reproducing it on a later turn.
  it("replaces the raw id with a short handle in the model-facing output, never exposing the raw id", async () => {
    const rawId =
      "AAMkAGI2TG92AAA=ZjY0LTQ5MGItYjA2NC1kNzk4ZjY0LWE1ZDQtcmVhbGx5LWxvbmctZ3JhcGgtaWQ=";
    const emails = [
      {
        id: rawId,
        from: "a@test.com",
        subject: "Hello",
        snippet: "Hi there",
      },
    ];
    mockList.mockResolvedValue(emails);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    const data = JSON.parse(result.content[0].text);
    expect(data[0].id).not.toBe(rawId);
    expect(data[0].id).toMatch(/^msg_[0-9a-f]+$/);
    expect(result.content[0].text).not.toContain(rawId);
  });

  it("gives the same email the same handle across repeated email_list calls (deterministic)", async () => {
    const rawId = "stable-graph-id-across-calls";
    mockList.mockResolvedValue([
      {
        id: rawId,
        from: "a@test.com",
        subject: "Hello",
        snippet: "Hi",
      },
    ]);

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const first = JSON.parse(
      (await tool.execute("call-1", {})).content[0].text,
    );
    const second = JSON.parse(
      (await tool.execute("call-2", {})).content[0].text,
    );

    expect(first[0].id).toBe(second[0].id);
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
    expect(data.body).toBe("Full body");
    // "msg-1" is a raw (non-prefixed) id, so it is passed through to the
    // adapter unchanged — Gmail compatibility / graceful fallback.
    expect(mockRead).toHaveBeenCalledWith("msg-1");
  });

  it("replaces the raw email id with a handle in the model-facing output (not the raw id)", async () => {
    const rawId = "raw-graph-message-id-should-not-be-echoed";
    const email = {
      id: rawId,
      from: "a@test.com",
      subject: "Hello",
      body: "Full body",
    };
    mockRead.mockResolvedValue(email);

    const tools = createApi();
    const tool = findTool(tools, "email_read", agentId)!;

    const result = await tool.execute("call-1", { id: rawId });

    const data = JSON.parse(result.content[0].text);
    expect(data.id).not.toBe(rawId);
    expect(data.id).toMatch(/^msg_[0-9a-f]+$/);
    expect(result.content[0].text).not.toContain(rawId);
  });

  it("does not add attachment guidance when the email has no attachments", async () => {
    const email = {
      id: "msg-1",
      from: "a@test.com",
      subject: "Hello",
      body: "Full body",
      attachments: [],
    };
    mockRead.mockResolvedValue(email);

    const tools = createApi();
    const tool = findTool(tools, "email_read", agentId)!;

    const result = await tool.execute("call-1", { id: "msg-1" });

    // Existing behavior preserved: exactly one JSON content block, still parseable.
    expect(result.content).toHaveLength(1);
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toMatch(/^msg_[0-9a-f]+$/);
  });

  it("appends attachment guidance pointing to email_get_attachment when attachments are present, using handles not raw ids", async () => {
    const email = {
      id: "msg-1",
      from: "a@test.com",
      subject: "Hello",
      body: "Full body",
      attachments: [
        {
          id: "att-1",
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          size: 12345,
        },
        {
          id: "att-2",
          filename: "photo.png",
          mimeType: "image/png",
          size: 2048,
        },
      ],
    };
    mockRead.mockResolvedValue(email);

    const tools = createApi();
    const tool = findTool(tools, "email_read", agentId)!;

    const result = await tool.execute("call-1", { id: "msg-1" });

    // First block remains the untouched JSON payload, but with handles
    // substituted for the raw message/attachment ids.
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toMatch(/^msg_[0-9a-f]+$/);
    expect(data.attachments).toHaveLength(2);
    expect(data.attachments[0].id).toMatch(/^att_[0-9a-f]+$/);
    expect(data.attachments[1].id).toMatch(/^att_[0-9a-f]+$/);
    expect(data.attachments[0].id).not.toBe(data.attachments[1].id);

    // Guidance is additive — a second block, not a restructure of the first.
    expect(result.content.length).toBeGreaterThan(1);
    const guidance = result.content
      .slice(1)
      .map((b) => b.text)
      .join("\n");
    expect(guidance).toContain("email_get_attachment");
    expect(guidance).toContain(data.id);
    expect(guidance).toContain(data.attachments[0].id);
    expect(guidance).toContain("invoice.pdf");
    expect(guidance).toContain("application/pdf");
    expect(guidance).toContain(data.attachments[1].id);
    expect(guidance).toContain("photo.png");
    // Raw ids must never leak into the guidance text either.
    expect(guidance).not.toContain("msg-1");
    expect(guidance).not.toContain("att-1");
    expect(guidance).not.toContain("att-2");
  });
});

describe("email_search", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("searches emails with DSL fields", async () => {
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

    const result = await tool.execute("call-1", {
      from: "b@test.com",
      subject: "invoice",
      limit: 5,
    });

    const data = JSON.parse(result.content[0].text);
    expect(data).toHaveLength(1);
    expect(mockSearch).toHaveBeenCalledWith({
      from: "b@test.com",
      subject: "invoice",
      limit: 5,
    });
  });

  // REGRESSION (#328 follow-up): email_search used to accept a raw Gmail
  // `query` string. It was replaced by structured DSL fields, but nothing
  // guarded the handler against a caller still passing the old `query` —
  // the value was silently dropped and the adapter threw a generic "search
  // requires at least one filter field" that never mentioned `query`. The
  // handler must catch this before it ever reaches the adapter and name the
  // replacement fields so the model can self-correct.
  it("rejects the legacy `query` parameter with a descriptive error naming the replacement DSL fields", async () => {
    const tools = createApi();
    const tool = findTool(tools, "email_search", agentId)!;

    const result = await tool.execute("call-1", {
      query: "from:alice subject:invoice",
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("query");
    expect(text).toContain("from");
    expect(text).toContain("to");
    expect(text).toContain("subject");
    expect(text).toContain("unread");
    expect(text).toContain("sinceDays");
    expect(text).toContain("folder");
    expect(text).toContain("limit");
    // The adapter must never be reached — the guard fires before the call.
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("rejects `query` even when valid DSL fields are also present (ambiguous intent)", async () => {
    const tools = createApi();
    const tool = findTool(tools, "email_search", agentId)!;

    const result = await tool.execute("call-1", {
      query: "from:alice",
      from: "alice@test.com",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("query");
    expect(mockSearch).not.toHaveBeenCalled();
  });

  it("ignores an empty-string `query` and still runs the DSL search unchanged", async () => {
    mockSearch.mockResolvedValue([]);
    const tools = createApi();
    const tool = findTool(tools, "email_search", agentId)!;

    const result = await tool.execute("call-1", {
      query: "",
      subject: "invoice",
    });

    expect(result.isError).toBeUndefined();
    expect(mockSearch).toHaveBeenCalledWith({ subject: "invoice" });
  });

  // Capability restoration (PR #328 follow-up): `text` is a NEW field for
  // free-text/body search, distinct from the legacy `query` raw-query string
  // rejected above. It must flow through into the adapter's SearchOptions.
  it("forwards `text` into the adapter's SearchOptions", async () => {
    mockSearch.mockResolvedValue([]);
    const tools = createApi();
    const tool = findTool(tools, "email_search", agentId)!;

    const result = await tool.execute("call-1", {
      text: "PO-1234",
    });

    expect(result.isError).toBeUndefined();
    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ text: "PO-1234" }),
    );
  });

  it("combines `text` with other DSL fields when forwarding to the adapter", async () => {
    mockSearch.mockResolvedValue([]);
    const tools = createApi();
    const tool = findTool(tools, "email_search", agentId)!;

    await tool.execute("call-1", {
      text: "invoice",
      from: "b@test.com",
    });

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ text: "invoice", from: "b@test.com" }),
    );
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
    // The model-facing draftId must be a handle, never the raw provider id —
    // otherwise a weak model echoing a ~150-char Graph id back on a later turn
    // re-hits the corruption this whole feature exists to prevent (Finding 1,
    // 2026-07-07 review of PR #673).
    expect(data.draftId).not.toBe("draft-1");
    expect(data.draftId.startsWith(`${MSG_PREFIX}_`)).toBe(true);
    expect(resolveHandle(agentId, data.draftId)).toBe("draft-1");
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
    // The model-facing messageId must be a handle, never the raw provider id.
    // If the model later reads the sent message back by copying this id into
    // email_read, a raw ~150-char Graph id would flow straight to the adapter
    // and reintroduce ErrorInvalidIdMalformed (Finding 1, 2026-07-07 review).
    expect(data.messageId).not.toBe("sent-1");
    expect(data.messageId.startsWith(`${MSG_PREFIX}_`)).toBe(true);
    expect(resolveHandle(agentId, data.messageId)).toBe("sent-1");
    expect(mockSend).toHaveBeenCalledWith({
      to: "recipient@test.com",
      subject: "Sent Subject",
      body: "Sent body text",
      replyTo: undefined,
    });
  });

  it("reports a direct send honestly when the adapter returns messageId: null (Graph's 202-with-no-location case) instead of fabricating an empty id", async () => {
    mockSend.mockResolvedValue({ messageId: null });

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
    // The result must not silently claim a fabricated "" id — either the
    // field is absent/null, or the surrounding text makes clear no id is
    // available. It must NOT be an empty string standing in as a fake id.
    expect(data.messageId).not.toBe("");
    expect(data.messageId).toBeNull();
    const allText = result.content.map((c) => c.text).join("\n");
    expect(allText).toMatch(/sent/i);
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

  // Audit-integrity contract (see packages/web/src/app/api/internal/audit/tool-use/route.ts
  // lines ~116-122, issue #404): OpenClaw strips the MCP `isError` flag before
  // forwarding tool results to /api/internal/audit/tool-use, so the audit
  // endpoint falls back to `result.details.error` to record a failure.
  // Without it, a failed email tool call is logged as outcome=success (verified
  // on staging: tool.email_read and tool.email_get_attachment rows logged
  // outcome=success despite an "Id is malformed" failure).
  it("attaches details.error on a client-thrown error so the audit records a failure even when OpenClaw strips isError", async () => {
    mockList.mockRejectedValue(new Error("Gmail API rate limit exceeded"));

    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect((result.details as { error?: string } | undefined)?.error).toContain(
      "Gmail API rate limit exceeded",
    );
    // The details.error message must match content[0].text (same human-readable string).
    expect((result.details as { error?: string } | undefined)?.error).toBe(
      result.content[0].text,
    );
  });

  it("attaches details.error on a permission-denied result", async () => {
    const tools = createApi();
    const tool = findTool(tools, "email_send", agentId)!;

    const result = await tool.execute("call-1", {
      to: "test@example.com",
      subject: "Hello",
      body: "World",
    });

    expect(result.isError).toBe(true);
    expect((result.details as { error?: string } | undefined)?.error).toContain(
      "Permission denied",
    );
    expect((result.details as { error?: string } | undefined)?.error).toBe(
      result.content[0].text,
    );
  });
});

describe("email_get_attachment", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
    // Default: no filename collision (target path does not exist yet).
    mockAccess.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
  });

  it("is gated on email.read permission and never touches the filesystem when denied", async () => {
    const configNoRead: PluginConfig = {
      ...testConfig,
      agents: {
        "agent-1": {
          connectionId: "conn-1",
          permissions: { email: [] },
        },
      },
    };
    const tools = createApi(configNoRead);
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockFetch).not.toHaveBeenCalled();
    expect(mockGetAttachment).not.toHaveBeenCalled();
    expect(mockMkdir).not.toHaveBeenCalled();
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it("downloads the attachment and writes it to the agent's uploads directory", async () => {
    const data = Buffer.from("pdf-bytes-here");
    mockGetAttachment.mockResolvedValue({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      data,
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetAttachment).toHaveBeenCalledWith("msg-1", "att-1");
    expect(mockMkdir).toHaveBeenCalledWith(
      "/root/.openclaw/workspaces/agent-1/uploads",
      { recursive: true },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/root/.openclaw/workspaces/agent-1/uploads/invoice.pdf",
      data,
      { flag: "wx" },
    );

    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toBe("invoice.pdf");
    expect(payload.size).toBe(data.length);
    expect(payload.mimeType).toBe("application/pdf");

    // Guidance references the hand-off to odoo_attach_file and the written name.
    const guidance = result.content
      .slice(1)
      .map((b) => b.text)
      .join("\n");
    expect(guidance).toContain("odoo_attach_file");
    expect(guidance).toContain("invoice.pdf");
  });

  it("never includes attachment content/bytes in the tool result", async () => {
    const data = Buffer.from("super-secret-binary-content");
    mockGetAttachment.mockResolvedValue({
      filename: "secret.bin",
      mimeType: "application/octet-stream",
      data,
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    const fullText = result.content.map((b) => b.text).join("\n");
    expect(fullText).not.toContain("super-secret-binary-content");
    expect(fullText).not.toContain(data.toString("base64"));
  });

  it("sanitizes a path-traversal filename (POSIX) so the write stays inside uploads/", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "../../etc/passwd",
      mimeType: "text/plain",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBeFalsy();
    const [writtenPath] = mockWriteFile.mock.calls[0] as [string, Buffer];
    expect(
      writtenPath.startsWith("/root/.openclaw/workspaces/agent-1/uploads/"),
    ).toBe(true);
    expect(writtenPath).not.toContain("..");
    expect(writtenPath).not.toContain("/etc/passwd");

    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).not.toContain("/");
    expect(payload.filename).not.toContain("\\");
    expect(payload.filename).not.toContain("..");
  });

  it("sanitizes a path-traversal filename (Windows-style backslashes)", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "..\\..\\evil.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBeFalsy();
    const [writtenPath] = mockWriteFile.mock.calls[0] as [string, Buffer];
    expect(
      writtenPath.startsWith("/root/.openclaw/workspaces/agent-1/uploads/"),
    ).toBe(true);
    expect(writtenPath).not.toContain("\\");
    expect(writtenPath).not.toContain("..");

    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).not.toContain("\\");
    expect(payload.filename).not.toContain("..");
  });

  it("falls back to a generated name for an empty filename, using the mime type for the extension", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "",
      mimeType: "application/pdf",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-12345",
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toMatch(/^attachment-.+\.pdf$/);
  });

  it("falls back to a .bin extension for an unrecognized mime type with an empty filename", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "   ",
      mimeType: "application/x-mystery",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-99999",
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toMatch(/^attachment-.+\.bin$/);
  });

  it("appends a numeric suffix on filename collision instead of overwriting", async () => {
    // First access() check (invoice.pdf) resolves => file exists => collision.
    // Second access() check (invoice-1.pdf) rejects ENOENT => free name.
    mockAccess
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      );
    mockGetAttachment.mockResolvedValue({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBeFalsy();
    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toBe("invoice-1.pdf");
    expect(mockWriteFile).toHaveBeenCalledWith(
      "/root/.openclaw/workspaces/agent-1/uploads/invoice-1.pdf",
      expect.anything(),
      { flag: "wx" },
    );
    // Never overwrite: writeFile must only ever be called with the free name,
    // and the exclusive "wx" flag makes that guarantee atomic.
    expect(mockWriteFile).toHaveBeenCalledTimes(1);
  });

  it("keeps incrementing the suffix until a free name is found", async () => {
    mockAccess
      .mockResolvedValueOnce(undefined) // invoice.pdf exists
      .mockResolvedValueOnce(undefined) // invoice-1.pdf exists
      .mockResolvedValueOnce(undefined) // invoice-2.pdf exists
      .mockRejectedValueOnce(
        Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
      ); // invoice-3.pdf free
    mockGetAttachment.mockResolvedValue({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("x"),
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.filename).toBe("invoice-3.pdf");
  });

  it("rejects an attachment whose downloaded byte length exceeds the 25 MB cap", async () => {
    const oversized = Buffer.alloc(25 * 1024 * 1024 + 1);
    mockGetAttachment.mockResolvedValue({
      filename: "big.pdf",
      mimeType: "application/pdf",
      data: oversized,
    });

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-1",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("25 MB");
    expect(mockWriteFile).not.toHaveBeenCalled();
    // No content/bytes leaked in the error path either.
    const fullText = result.content.map((b) => b.text).join("\n");
    expect(fullText).not.toContain(oversized.toString("base64").slice(0, 50));
  });

  it("requires messageId and attachmentId parameters", async () => {
    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;
    expect(tool.parameters).toMatchObject({
      required: expect.arrayContaining(["messageId", "attachmentId"]),
    });
  });

  it("propagates adapter errors via errorResult", async () => {
    mockGetAttachment.mockRejectedValue(new Error("attachment not found"));

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg-1",
      attachmentId: "att-missing",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("attachment not found");
    expect(mockWriteFile).not.toHaveBeenCalled();
  });
});

// Handle-indirection (Bug B, 2026-07-07 debugging session; sibling of PR
// #668): email_list/email_search/email_read hand out short handles instead
// of raw provider ids. email_read/email_get_attachment/email_draft/email_send
// must resolve those handles back to the real id before calling the adapter.
describe("id-handle indirection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCredentialResponse();
  });

  it("list -> read round trip: a handle produced by email_list resolves to the correct realId at the adapter", async () => {
    const rawId = "AAMkAGI2-real-graph-message-id-that-is-very-long";
    mockList.mockResolvedValue([
      {
        id: rawId,
        from: "a@test.com",
        subject: "Hello",
        snippet: "Hi",
      },
    ]);

    const tools = createApi();
    const listTool = findTool(tools, "email_list", agentId)!;
    const listResult = await listTool.execute("call-1", {});
    const [{ id: handle }] = JSON.parse(listResult.content[0].text);
    expect(handle).not.toBe(rawId);

    mockRead.mockResolvedValue({
      id: rawId,
      from: "a@test.com",
      subject: "Hello",
      body: "Full body",
    });
    const readTool = findTool(tools, "email_read", agentId)!;
    const readResult = await readTool.execute("call-2", { id: handle });

    expect(readResult.isError).toBeFalsy();
    expect(mockRead).toHaveBeenCalledWith(rawId);
  });

  it("search -> read round trip: a handle produced by email_search also resolves correctly", async () => {
    const rawId = "search-produced-raw-id";
    mockSearch.mockResolvedValue([
      {
        id: rawId,
        from: "b@test.com",
        subject: "Invoice",
        snippet: "Please pay",
      },
    ]);

    const tools = createApi();
    const searchTool = findTool(tools, "email_search", agentId)!;
    const searchResult = await searchTool.execute("call-1", {
      subject: "invoice",
    });
    const [{ id: handle }] = JSON.parse(searchResult.content[0].text);

    mockRead.mockResolvedValue({
      id: rawId,
      from: "b@test.com",
      subject: "Invoice",
      body: "body",
    });
    const readTool = findTool(tools, "email_read", agentId)!;
    await readTool.execute("call-2", { id: handle });

    expect(mockRead).toHaveBeenCalledWith(rawId);
  });

  it("read -> get_attachment round trip: attachment handles from email_read resolve to the correct ids at the adapter", async () => {
    const rawMsgId = "raw-message-id-for-attachment-flow";
    const rawAttId = "raw-attachment-id-abcdef";
    mockRead.mockResolvedValue({
      id: rawMsgId,
      from: "a@test.com",
      subject: "Hello",
      body: "body",
      attachments: [
        {
          id: rawAttId,
          filename: "invoice.pdf",
          mimeType: "application/pdf",
          size: 100,
        },
      ],
    });

    const tools = createApi();
    const readTool = findTool(tools, "email_read", agentId)!;
    const readResult = await readTool.execute("call-1", { id: rawMsgId });
    const data = JSON.parse(readResult.content[0].text);
    const msgHandle = data.id;
    const attHandle = data.attachments[0].id;
    expect(msgHandle).not.toBe(rawMsgId);
    expect(attHandle).not.toBe(rawAttId);

    mockGetAttachment.mockResolvedValue({
      filename: "invoice.pdf",
      mimeType: "application/pdf",
      data: Buffer.from("x"),
    });
    mockMkdir.mockResolvedValue(undefined);
    mockAccess.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    mockWriteFile.mockResolvedValue(undefined);

    const attTool = findTool(tools, "email_get_attachment", agentId)!;
    const attResult = await attTool.execute("call-2", {
      messageId: msgHandle,
      attachmentId: attHandle,
    });

    expect(attResult.isError).toBeFalsy();
    expect(mockGetAttachment).toHaveBeenCalledWith(rawMsgId, rawAttId);
  });

  it("email_read: an unknown/corrupted handle yields a failed result (isError + details.error) with a 're-list' message, without ever reaching the adapter", async () => {
    const tools = createApi();
    const readTool = findTool(tools, "email_read", agentId)!;

    const result = await readTool.execute("call-1", {
      id: "msg_deadbeef",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "The email reference 'msg_deadbeef' is unknown or has expired.",
    );
    expect(result.content[0].text).toContain("email_list");
    expect(result.content[0].text).toContain("email_search");
    const details = (result as { details?: { error?: string } }).details;
    expect(details?.error).toBeTruthy();
    expect(details?.error).toBe(result.content[0].text);
    expect(mockRead).not.toHaveBeenCalled();
  });

  it("email_get_attachment: an unknown messageId handle yields a failed result and never reaches the adapter", async () => {
    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "msg_unknownhandle",
      attachmentId: "att-1",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "The email reference 'msg_unknownhandle' is unknown or has expired.",
    );
    const details = (result as { details?: { error?: string } }).details;
    expect(details?.error).toBe(result.content[0].text);
    expect(mockGetAttachment).not.toHaveBeenCalled();
  });

  it("email_get_attachment: an unknown attachmentId handle yields a failed result and never reaches the adapter", async () => {
    const tools = createApi();
    const attTool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await attTool.execute("call-1", {
      messageId: "msg-1", // raw id, passes through fine
      attachmentId: "att_unknownhandle",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "The email reference 'att_unknownhandle' is unknown or has expired.",
    );
    expect(mockGetAttachment).not.toHaveBeenCalled();
  });

  it("email_draft: an unknown replyTo handle yields a failed result and never reaches the adapter", async () => {
    const tools = createApi();
    const draftTool = findTool(tools, "email_draft", agentId)!;

    const result = await draftTool.execute("call-1", {
      to: "test@example.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: "msg_unknownhandle",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "The email reference 'msg_unknownhandle' is unknown or has expired.",
    );
    expect(mockDraft).not.toHaveBeenCalled();
  });

  it("email_send: an unknown replyTo handle yields a failed result and never reaches the adapter", async () => {
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
    const sendTool = findTool(tools, "email_send", agentId)!;

    const result = await sendTool.execute("call-1", {
      to: "test@example.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: "msg_unknownhandle",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "The email reference 'msg_unknownhandle' is unknown or has expired.",
    );
    expect(mockSend).not.toHaveBeenCalled();
  });

  it("email_draft: a resolved replyTo handle is passed to the adapter as the realId, not the handle", async () => {
    const rawId = "raw-message-id-being-replied-to";
    mockList.mockResolvedValue([
      { id: rawId, from: "a@test.com", subject: "Hello", snippet: "Hi" },
    ]);
    const tools = createApi();
    const listTool = findTool(tools, "email_list", agentId)!;
    const listResult = await listTool.execute("call-1", {});
    const [{ id: handle }] = JSON.parse(listResult.content[0].text);

    mockDraft.mockResolvedValue({ draftId: "draft-1" });
    const draftTool = findTool(tools, "email_draft", agentId)!;
    await draftTool.execute("call-2", {
      to: "test@example.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: handle,
    });

    expect(mockDraft).toHaveBeenCalledWith({
      to: "test@example.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: rawId,
    });
  });

  it("email_send: a resolved replyTo handle is passed to the adapter as the realId, not the handle", async () => {
    const rawId = "raw-message-id-being-replied-to-send";
    mockList.mockResolvedValue([
      { id: rawId, from: "a@test.com", subject: "Hello", snippet: "Hi" },
    ]);
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
    const listTool = findTool(tools, "email_list", agentId)!;
    const listResult = await listTool.execute("call-1", {});
    const [{ id: handle }] = JSON.parse(listResult.content[0].text);

    mockSend.mockResolvedValue({ messageId: "sent-1" });
    const sendTool = findTool(tools, "email_send", agentId)!;
    await sendTool.execute("call-2", {
      to: "test@example.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: handle,
    });

    expect(mockSend).toHaveBeenCalledWith({
      to: "test@example.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: rawId,
    });
  });

  it("a raw (non-prefixed) id passed as replyTo is passed through to the adapter unchanged (Gmail compatibility)", async () => {
    mockDraft.mockResolvedValue({ draftId: "draft-1" });
    const tools = createApi();
    const draftTool = findTool(tools, "email_draft", agentId)!;

    await draftTool.execute("call-1", {
      to: "test@example.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: "raw-gmail-style-id",
    });

    expect(mockDraft).toHaveBeenCalledWith({
      to: "test@example.com",
      subject: "Re: Hello",
      body: "Reply body",
      replyTo: "raw-gmail-style-id",
    });
  });

  it("a raw (non-prefixed) messageId/attachmentId pair is passed through to the adapter unchanged", async () => {
    mockGetAttachment.mockResolvedValue({
      filename: "file.txt",
      mimeType: "text/plain",
      data: Buffer.from("hello"),
    });
    mockMkdir.mockResolvedValue(undefined);
    mockAccess.mockRejectedValue(
      Object.assign(new Error("ENOENT"), { code: "ENOENT" }),
    );
    mockWriteFile.mockResolvedValue(undefined);

    const tools = createApi();
    const tool = findTool(tools, "email_get_attachment", agentId)!;

    const result = await tool.execute("call-1", {
      messageId: "raw-message-id",
      attachmentId: "raw-attachment-id",
    });

    expect(result.isError).toBeFalsy();
    expect(mockGetAttachment).toHaveBeenCalledWith(
      "raw-message-id",
      "raw-attachment-id",
    );
  });

  it("agent isolation: a handle minted while serving one agent cannot be resolved by a different agent", async () => {
    const otherAgentConfig: PluginConfig = {
      apiBaseUrl: "http://pinchy:7777",
      gatewayToken: "test-gateway-token",
      agents: {
        "agent-1": {
          connectionId: "conn-1",
          permissions: { email: ["read", "draft"] },
        },
        "agent-2": {
          connectionId: "conn-2",
          permissions: { email: ["read", "draft"] },
        },
      },
    };
    const rawId = "agent-1-only-message-id";
    mockList.mockResolvedValue([
      { id: rawId, from: "a@test.com", subject: "Hello", snippet: "Hi" },
    ]);

    const tools = createApi(otherAgentConfig);
    const listTool = findTool(tools, "email_list", "agent-1")!;
    const listResult = await listTool.execute("call-1", {});
    const [{ id: handle }] = JSON.parse(listResult.content[0].text);

    const readToolForAgent2 = findTool(tools, "email_read", "agent-2")!;
    const result = await readToolForAgent2.execute("call-2", { id: handle });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unknown or has expired");
    expect(mockRead).not.toHaveBeenCalled();
  });

  // Finding 1 (2026-07-07 review): the handle store caps entries per agent and
  // evicts oldest-first. A single result set larger than that cap would evict
  // its own earliest handles as the later ones are minted, so the top rows the
  // model was just shown would resolve to "unknown or expired" — and re-listing
  // reproduces the same eviction, making them permanently unopenable. The tools
  // therefore clamp an over-large limit down to the store cap so a single
  // result set can never exceed it.
  it("email_list clamps an over-large limit to the handle-store cap", async () => {
    mockList.mockResolvedValue([]);
    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", { limit: MAX_ENTRIES_PER_AGENT + 5000 });

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_ENTRIES_PER_AGENT }),
    );
  });

  it("email_search clamps an over-large limit to the handle-store cap", async () => {
    mockSearch.mockResolvedValue([]);
    const tools = createApi();
    const tool = findTool(tools, "email_search", agentId)!;

    await tool.execute("call-1", {
      subject: "invoice",
      limit: MAX_ENTRIES_PER_AGENT + 5000,
    });

    expect(mockSearch).toHaveBeenCalledWith(
      expect.objectContaining({ limit: MAX_ENTRIES_PER_AGENT }),
    );
  });

  it("leaves a within-cap limit untouched", async () => {
    mockList.mockResolvedValue([]);
    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", { limit: 25 });

    expect(mockList).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 25 }),
    );
  });

  // Finding 2 (2026-07-07 review of PR #673): clampListLimit deckelte nur nach
  // oben. Ein vom Modell gesendetes limit <= 0 lief unverändert zum Adapter und
  // damit als $top/maxResults zum Provider — negativ ergibt einen 400, 0 ein
  // verwirrend leeres Ergebnis. Ein nicht-positives limit wird jetzt wie ein
  // fehlendes behandelt: undefined, damit der Adapter seinen Default nimmt.
  it("email_list drops a zero limit so the adapter applies its own default", async () => {
    mockList.mockResolvedValue([]);
    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", { limit: 0 });

    expect(mockList.mock.calls[0][0].limit).toBeUndefined();
  });

  it("email_list drops a negative limit so the adapter applies its own default", async () => {
    mockList.mockResolvedValue([]);
    const tools = createApi();
    const tool = findTool(tools, "email_list", agentId)!;

    await tool.execute("call-1", { limit: -5 });

    expect(mockList.mock.calls[0][0].limit).toBeUndefined();
  });

  it("email_search drops a non-positive limit so the adapter applies its own default", async () => {
    mockSearch.mockResolvedValue([]);
    const tools = createApi();
    const tool = findTool(tools, "email_search", agentId)!;

    await tool.execute("call-1", { subject: "invoice", limit: 0 });

    expect(mockSearch.mock.calls[0][0].limit).toBeUndefined();
  });

  it("email_send -> read round trip: the handle returned by email_send resolves to the real message id at the adapter", async () => {
    const rawSentId =
      "AAMkAGI2-real-graph-id-of-the-just-sent-message-very-long";
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

    mockSend.mockResolvedValue({ messageId: rawSentId });
    const sendTool = findTool(tools, "email_send", agentId)!;
    const sendResult = await sendTool.execute("call-1", {
      to: "recipient@test.com",
      subject: "Sent",
      body: "body",
    });
    const { messageId: handle } = JSON.parse(sendResult.content[0].text);
    expect(handle).not.toBe(rawSentId);

    mockRead.mockResolvedValue({
      id: rawSentId,
      from: "me@test.com",
      subject: "Sent",
      body: "body",
    });
    const readTool = findTool(tools, "email_read", agentId)!;
    const readResult = await readTool.execute("call-2", { id: handle });

    expect(readResult.isError).toBeFalsy();
    expect(mockRead).toHaveBeenCalledWith(rawSentId);
  });

  it("email_send leaves messageId null untouched (does not mint a handle for a non-id)", async () => {
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

    mockSend.mockResolvedValue({ messageId: null });
    const sendTool = findTool(tools, "email_send", agentId)!;
    const result = await sendTool.execute("call-1", {
      to: "recipient@test.com",
      subject: "Sent",
      body: "body",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.messageId).toBeNull();
  });
});
