import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuthenticate, mockFetch, realFetch } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockFetch: vi.fn(),
  // Captured before stubGlobal swaps it out, so the one end-to-end mcp test
  // below can do real loopback HTTP against a mock MCP server.
  realFetch: globalThis.fetch.bind(globalThis),
}));

vi.stubGlobal("fetch", mockFetch);

vi.mock("odoo-node", () => ({
  OdooClient: Object.assign(class {}, { authenticate: mockAuthenticate }),
}));
vi.mock("@/lib/integrations/odoo-sync", () => ({
  fetchOdooSchema: vi.fn(),
}));
vi.mock("@/lib/integrations/brave-probe", () => ({
  probeBraveApiKey: vi.fn(),
}));

const mockTestImapLogin = vi.fn();
const mockTestSmtpVerify = vi.fn();
// Only the network I/O (testImapLogin/testSmtpVerify) is mocked; friendlyError
// comes from the REAL module via importActual. The imap branch of probe.ts
// classifies transient-vs-auth by matching the real friendlyError wording
// (/authentication failed/i), so re-implementing it here would let a reword of
// the real string silently break auth-failure detection while this test stayed
// green. Importing the real one makes that coupling a real compile/run check.
vi.mock("@/lib/integrations/imap-probe", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/integrations/imap-probe")>();
  return {
    ...actual,
    testImapLogin: (...args: unknown[]) => mockTestImapLogin(...args),
    testSmtpVerify: (...args: unknown[]) => mockTestSmtpVerify(...args),
  };
});

const mockListMcpTools = vi.fn();
// Holds the REAL listMcpTools so the end-to-end test at the bottom of the mcp
// block can opt back into it while every other test keeps the fast fake.
const mcpClientActual = vi.hoisted(
  () => ({}) as { listMcpTools?: typeof import("@/lib/integrations/mcp-client").listMcpTools }
);
// Only the network I/O (listMcpTools) is mocked; the typed error classes come
// from the REAL module via importActual, exactly like the imap-probe pattern
// above. The mcp branch of probe.ts classifies transient-vs-auth via
// `instanceof McpAuthError` etc., so re-implementing fakes here would let the
// real classes drift from the classification silently.
vi.mock("@/lib/integrations/mcp-client", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/integrations/mcp-client")>();
  mcpClientActual.listMcpTools = actual.listMcpTools;
  return {
    ...actual,
    listMcpTools: (...args: unknown[]) => mockListMcpTools(...args),
  };
});

import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { probeBraveApiKey } from "@/lib/integrations/brave-probe";
import { probeIntegrationCredentials } from "@/lib/integrations/probe";
import { McpAuthError, McpServerError, McpSchemaError } from "@/lib/integrations/mcp-client";
import { createMcpMockServer } from "@/test-utils/mcp-mock-server";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue(2);
});

describe("probeIntegrationCredentials", () => {
  const validOdooCreds = {
    url: "https://odoo.example.com",
    db: "mydb",
    login: "admin",
    apiKey: "sk-xxx",
    uid: 1,
  };

  it("odoo: returns success with freshCredentials when fetchOdooSchema succeeds", async () => {
    vi.mocked(fetchOdooSchema).mockResolvedValue({
      success: true,
      models: 5,
      data: {} as never,
      lastSyncAt: new Date().toISOString(),
    } as never);
    const res = await probeIntegrationCredentials("odoo", validOdooCreds);
    expect(res).toEqual({ success: true, freshCredentials: { uid: 2 } });
  });

  it("odoo: returns failure with reason from fetchOdooSchema", async () => {
    vi.mocked(fetchOdooSchema).mockResolvedValue({
      success: false,
      error: "Access denied",
    } as never);
    const res = await probeIntegrationCredentials("odoo", validOdooCreds);
    expect(res).toEqual({ success: false, reason: "Access denied" });
  });

  it("odoo: returns failure for invalid credentials shape", async () => {
    const res = await probeIntegrationCredentials("odoo", {
      url: "https://o",
      db: "p",
      login: "u",
    });
    expect(res).toEqual({ success: false, reason: "Invalid credentials format" });
    expect(fetchOdooSchema).not.toHaveBeenCalled();
  });

  it("web-search: delegates to probeBraveApiKey", async () => {
    vi.mocked(probeBraveApiKey).mockResolvedValue({ success: true });
    const res = await probeIntegrationCredentials("web-search", { apiKey: "k" });
    expect(res).toEqual({ success: true });
    expect(probeBraveApiKey).toHaveBeenCalledWith("k");
  });

  it("web-search: returns failure when apiKey is missing", async () => {
    const res = await probeIntegrationCredentials("web-search", {});
    expect(res).toEqual({ success: false, reason: "apiKey is required" });
    expect(probeBraveApiKey).not.toHaveBeenCalled();
  });

  it("returns failure with explicit message for unknown type", async () => {
    const res = await probeIntegrationCredentials("unknown-type" as never, {});
    expect(res).toEqual({
      success: false,
      reason: "Cannot probe credentials for unknown type: unknown-type",
    });
  });

  describe("microsoft", () => {
    const validCreds = {
      accessToken: "valid-access-token",
      refreshToken: "valid-refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };

    it("returns success when Graph /me returns 200", async () => {
      mockFetch.mockResolvedValue({ ok: true, status: 200 });
      const res = await probeIntegrationCredentials("microsoft", validCreds);
      expect(res).toEqual({ success: true });
      expect(mockFetch).toHaveBeenCalledWith(
        expect.stringContaining("/v1.0/me"),
        expect.objectContaining({
          headers: { Authorization: "Bearer valid-access-token" },
        })
      );
    });

    it("returns failure when Graph /me returns 401", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 401 });
      const res = await probeIntegrationCredentials("microsoft", validCreds);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.reason).toMatch(/reconnect.*Microsoft/i);
      expect(res.transient).toBeFalsy();
    });

    it("returns non-transient failure when Graph /me returns 403", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 403 });
      const res = await probeIntegrationCredentials("microsoft", validCreds);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.reason).toMatch(/reconnect.*Microsoft/i);
      expect(res.transient).toBeFalsy();
    });

    it("returns transient failure with a distinct reason when Graph /me returns 503", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 503 });
      const res = await probeIntegrationCredentials("microsoft", validCreds);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
      expect(res.reason).toMatch(/503/);
      expect(res.reason).not.toMatch(/reconnect/i);
    });

    it("returns transient failure when Graph /me returns 429", async () => {
      mockFetch.mockResolvedValue({ ok: false, status: 429 });
      const res = await probeIntegrationCredentials("microsoft", validCreds);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
      expect(res.reason).toMatch(/429/);
    });

    it("returns failure when accessToken is missing", async () => {
      const res = await probeIntegrationCredentials("microsoft", {});
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.reason).toMatch(/reconnect/i);
      expect(mockFetch).not.toHaveBeenCalled();
    });

    it("returns transient failure on network error", async () => {
      mockFetch.mockRejectedValue(new Error("network error"));
      const res = await probeIntegrationCredentials("microsoft", validCreds);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
    });
  });

  describe("odoo authentication", () => {
    it("returns clear auth-failed message when OdooClient.authenticate throws", async () => {
      mockAuthenticate.mockRejectedValue(new Error("Invalid credentials"));
      const res = await probeIntegrationCredentials("odoo", validOdooCreds);
      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.reason).toMatch(/authentication failed/i);
      expect(res.reason).toMatch(/login.*api key|api key.*login/i);
      expect(fetchOdooSchema).not.toHaveBeenCalled();
    });

    it("re-resolves uid by re-authenticating with login + apiKey, passes fresh uid to fetchOdooSchema", async () => {
      mockAuthenticate.mockResolvedValue(42); // fresh uid from Odoo
      vi.mocked(fetchOdooSchema).mockResolvedValue({
        success: true,
        models: 5,
        data: {} as never,
        lastSyncAt: new Date().toISOString(),
      } as never);

      await probeIntegrationCredentials("odoo", {
        ...validOdooCreds,
        uid: 2, // stale, should be replaced by 42
      });

      expect(mockAuthenticate).toHaveBeenCalledWith({
        url: validOdooCreds.url,
        db: validOdooCreds.db,
        login: validOdooCreds.login,
        apiKey: validOdooCreds.apiKey,
      });
      expect(fetchOdooSchema).toHaveBeenCalledWith(expect.objectContaining({ uid: 42 }));
    });

    it("returns the fresh uid on success so caller can persist it (login change)", async () => {
      mockAuthenticate.mockResolvedValue(42);
      vi.mocked(fetchOdooSchema).mockResolvedValue({ success: true } as never);

      const res = await probeIntegrationCredentials("odoo", validOdooCreds);

      expect(res).toEqual({ success: true, freshCredentials: { uid: 42 } });
    });

    it("does NOT call fetchOdooSchema when authentication fails (avoids opaque 'no models' message)", async () => {
      mockAuthenticate.mockRejectedValue(new Error("AccessDenied"));
      await probeIntegrationCredentials("odoo", validOdooCreds);
      expect(fetchOdooSchema).not.toHaveBeenCalled();
    });
  });

  describe("imap", () => {
    const validImapCreds = {
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      username: "mailbox@example.com",
      password: "super-secret-app-password",
      security: "tls" as const,
    };

    beforeEach(() => {
      mockTestImapLogin.mockResolvedValue(undefined);
      mockTestSmtpVerify.mockResolvedValue(undefined);
    });

    it("returns success when both IMAP login and SMTP verify succeed", async () => {
      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res).toEqual({ success: true });
      expect(mockTestImapLogin).toHaveBeenCalledWith(validImapCreds);
      expect(mockTestSmtpVerify).toHaveBeenCalledWith(validImapCreds);
    });

    it("returns non-transient failure with a friendly reason on IMAP auth failure", async () => {
      mockTestImapLogin.mockRejectedValue(new Error("Invalid credentials (535)"));

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.reason).toMatch(/authentication failed/i);
      expect(res.transient).toBeFalsy();
      // SMTP should not even be attempted once IMAP has already failed.
      expect(mockTestSmtpVerify).not.toHaveBeenCalled();
    });

    it("returns non-transient failure with a friendly reason on SMTP auth failure", async () => {
      mockTestSmtpVerify.mockRejectedValue(new Error("535 Authentication failed"));

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.reason).toMatch(/authentication failed/i);
      expect(res.transient).toBeFalsy();
    });

    it("returns transient:true for a connection/timeout error so callers do not flip to auth_failed", async () => {
      mockTestImapLogin.mockRejectedValue(new Error("connect ECONNREFUSED 127.0.0.1:993"));

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
      expect(res.reason).toMatch(/could not connect/i);
    });

    it("returns transient:true for a timeout error", async () => {
      mockTestImapLogin.mockRejectedValue(new Error("Connection timed out"));

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
      expect(res.reason).toMatch(/timed out/i);
    });

    it("returns transient:true for a 'could not connect' error", async () => {
      mockTestImapLogin.mockRejectedValue(new Error("getaddrinfo ENOTFOUND imap.example.com"));

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
      expect(res.reason).toMatch(/could not connect/i);
    });

    it("returns transient:true for a TLS/certificate error (secure-connection failure)", async () => {
      mockTestImapLogin.mockRejectedValue(new Error("self signed certificate in chain"));

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
      expect(res.reason).toMatch(/secure connection/i);
    });

    it("returns transient:true for a socket-hang-up error that maps to the generic fallback", async () => {
      // "socket hang up" / ECONNRESET are genuinely transient but map to
      // friendlyError's generic "Connection failed" fallback, matching none of
      // an allowlist. The fail-safe default must still classify this transient
      // so a healthy connection is never flipped to auth_failed on a blip.
      mockTestSmtpVerify.mockRejectedValue(new Error("socket hang up"));

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
      expect(res.reason).toMatch(/connection failed/i);
    });

    it("returns transient:true for any unmapped error (fail-safe default)", async () => {
      mockTestImapLogin.mockRejectedValue(new Error("some totally unmapped runtime error"));

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
    });

    it("returns failure for invalid credentials shape without probing", async () => {
      const res = await probeIntegrationCredentials("imap", { imapHost: "only-host" });

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBeFalsy();
      expect(mockTestImapLogin).not.toHaveBeenCalled();
      expect(mockTestSmtpVerify).not.toHaveBeenCalled();
    });

    it("never includes the plaintext password in the returned reason", async () => {
      mockTestImapLogin.mockRejectedValue(
        new Error(`Authentication failed for password ${validImapCreds.password}`)
      );

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.reason).not.toContain(validImapCreds.password);
    });
  });

  describe("mcp", () => {
    const validData = {
      type: "mcp" as const,
      preset: "github" as const,
      transport: "http" as const,
      url: "https://api.githubcopilot.com/mcp/",
      tools: [],
      lastSyncAt: new Date().toISOString(),
    };
    const validCreds = { token: "pat-fresh-token" };

    it("returns success and calls listMcpTools with url/transport/token/extraHeaders from data+credentials", async () => {
      mockListMcpTools.mockResolvedValue([{ name: "create_issue", inputSchema: {} }]);
      const dataWithHeaders = { ...validData, extraHeaders: { locationId: "loc_1" } };

      const res = await probeIntegrationCredentials("mcp", validCreds, dataWithHeaders);

      expect(res).toEqual({ success: true });
      expect(mockListMcpTools).toHaveBeenCalledWith({
        url: validData.url,
        transport: validData.transport,
        token: "pat-fresh-token",
        extraHeaders: { locationId: "loc_1" },
      });
    });

    it("returns non-transient failure without probing when data is missing (connection.data was never persisted)", async () => {
      const res = await probeIntegrationCredentials("mcp", validCreds, null);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBeFalsy();
      expect(mockListMcpTools).not.toHaveBeenCalled();
    });

    it("returns non-transient failure without probing when data is missing url/transport", async () => {
      const res = await probeIntegrationCredentials("mcp", validCreds, { preset: "github" });

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBeFalsy();
      expect(mockListMcpTools).not.toHaveBeenCalled();
    });

    it("returns non-transient failure without probing when the token is missing", async () => {
      const res = await probeIntegrationCredentials("mcp", {}, validData);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBeFalsy();
      expect(mockListMcpTools).not.toHaveBeenCalled();
    });

    it("returns non-transient failure on McpAuthError — the only mcp failure allowed to flip a connection to auth_failed", async () => {
      mockListMcpTools.mockRejectedValue(new McpAuthError());

      const res = await probeIntegrationCredentials("mcp", validCreds, validData);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBeFalsy();
      expect(res.reason).not.toMatch(/MCP|401/);
    });

    it("returns transient:true on McpServerError (5xx/429) — a provider hiccup, not proof the token is bad", async () => {
      mockListMcpTools.mockRejectedValue(new McpServerError(503, "boom"));

      const res = await probeIntegrationCredentials("mcp", validCreds, validData);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
    });

    it("returns transient:true on McpSchemaError (fail-safe: a broken response is not evidence the token is bad)", async () => {
      mockListMcpTools.mockRejectedValue(new McpSchemaError("tool missing name"));

      const res = await probeIntegrationCredentials("mcp", validCreds, validData);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
    });

    it("returns transient:true for a network/DNS/timeout/abort failure (fail-safe default)", async () => {
      mockListMcpTools.mockRejectedValue(new Error("This operation was aborted"));

      const res = await probeIntegrationCredentials("mcp", validCreds, validData);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.transient).toBe(true);
    });

    it("never includes the plaintext token in the returned reason", async () => {
      mockListMcpTools.mockRejectedValue(
        new Error(`connect ECONNREFUSED, sent token ${validCreds.token}`)
      );

      const res = await probeIntegrationCredentials("mcp", validCreds, validData);

      expect(res.success).toBe(false);
      if (res.success) return;
      expect(res.reason).not.toContain(validCreds.token);
    });

    // End-to-end over the REAL listMcpTools + real loopback HTTP. The tests
    // above mock the client, so they can only prove "given an McpAuthError,
    // probe says non-transient" — they'd stay green even if the client never
    // produced an McpAuthError for a 403 in the first place. This one pins the
    // whole chain a user actually hits: HTTP 403 → McpAuthError → auth_failed
    // (not the "server unreachable, try again" lie that shipped before).
    it("classifies a real 403 from an MCP server as a non-transient auth failure (full chain)", async () => {
      vi.stubEnv("ALLOW_PRIVATE_URLS", "1"); // loopback must pass the SSRF guard
      mockFetch.mockImplementation((...args: Parameters<typeof fetch>) => realFetch(...args));
      mockListMcpTools.mockImplementation((...args: unknown[]) =>
        (mcpClientActual.listMcpTools as unknown as (...a: unknown[]) => Promise<unknown>)(...args)
      );
      const mock = await createMcpMockServer("forbidden");

      try {
        const res = await probeIntegrationCredentials(
          "mcp",
          { token: "under-scoped-token" },
          { ...validData, url: `http://127.0.0.1:${mock.port}/mcp` }
        );

        expect(res.success).toBe(false);
        if (res.success) return;
        expect(res.transient).toBeFalsy();
        // The message must point at the token, not at reachability.
        expect(res.reason).toMatch(/token/i);
        expect(res.reason).not.toMatch(/reach/i);
      } finally {
        await mock.close();
        vi.unstubAllEnvs();
      }
    }, 10000);
  });
});
