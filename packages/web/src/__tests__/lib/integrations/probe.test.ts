import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockAuthenticate, mockFetch } = vi.hoisted(() => ({
  mockAuthenticate: vi.fn(),
  mockFetch: vi.fn(),
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
// and classifyProbeError come from the REAL module via importActual. The imap
// branch of probe.ts classifies transient-vs-auth via the real
// classifyProbeError()'s code === "auth", so re-implementing that mapping
// here would let a change to the real classifier silently break auth-failure
// detection while this test stayed green. Importing the real one makes that
// coupling a real compile/run check.
vi.mock("@/lib/integrations/imap-probe", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/integrations/imap-probe")>();
  return {
    ...actual,
    testImapLogin: (...args: unknown[]) => mockTestImapLogin(...args),
    testSmtpVerify: (...args: unknown[]) => mockTestSmtpVerify(...args),
  };
});

// The guard's decisions are tested in stored-destination.test.ts; here it is a
// seam (and keeps these cases off the real resolver).
const mockCheckStoredDestination = vi.fn();
vi.mock("@/lib/integrations/stored-destination", () => ({
  checkStoredDestination: (...args: unknown[]) => mockCheckStoredDestination(...args),
}));

import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { probeBraveApiKey } from "@/lib/integrations/brave-probe";
import { probeIntegrationCredentials } from "@/lib/integrations/probe";
import { resetInsecureMockWarningsForTest } from "@/lib/integrations/insecure-mock-base-url";

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthenticate.mockResolvedValue(2);
  mockCheckStoredDestination.mockResolvedValue({ allowed: true });
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

    it("ignores GRAPH_API_BASE_URL and probes the real Graph host when the insecure flag is absent", async () => {
      vi.stubEnv("GRAPH_API_BASE_URL", "http://graph-mock:9005");
      // No PINCHY_INSECURE_MAIL_MOCK: this probe sends the stored access token.
      vi.spyOn(console, "warn").mockImplementation(() => {});
      resetInsecureMockWarningsForTest();
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await probeIntegrationCredentials("microsoft", validCreds);

      expect(mockFetch).toHaveBeenCalledWith(
        "https://graph.microsoft.com/v1.0/me",
        expect.any(Object)
      );
      vi.unstubAllEnvs();
      resetInsecureMockWarningsForTest();
    });

    it("uses GRAPH_API_BASE_URL when the insecure flag is set", async () => {
      vi.stubEnv("GRAPH_API_BASE_URL", "http://graph-mock:9005");
      vi.stubEnv("PINCHY_INSECURE_MAIL_MOCK", "1");
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      await probeIntegrationCredentials("microsoft", validCreds);

      expect(mockFetch).toHaveBeenCalledWith("http://graph-mock:9005/v1.0/me", expect.any(Object));
      vi.unstubAllEnvs();
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

  describe("odoo: the URL is checked before anything is sent to it", () => {
    // Callers hand this function a merged credential set whose URL may have
    // come from the database rather than the request (PATCH with only a new
    // API key), so it was never re-validated against the current rules.
    it("refuses a URL the guard refuses, without authenticating against it", async () => {
      mockCheckStoredDestination.mockResolvedValue({
        allowed: false,
        field: "url",
        message: "Blocked: this URL targets a private network address.",
      });

      const res = await probeIntegrationCredentials("odoo", validOdooCreds);

      expect(mockCheckStoredDestination).toHaveBeenCalledWith("odoo", validOdooCreds);
      // `transient`: a refused address says nothing about the API key, so no
      // caller may read it as an auth failure and flag the connection.
      expect(res).toEqual({
        success: false,
        transient: true,
        reason: "Blocked: this URL targets a private network address.",
      });
      expect(mockAuthenticate).not.toHaveBeenCalled();
      expect(fetchOdooSchema).not.toHaveBeenCalled();
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

    // The errors below come from the real OdooError class, in the shapes
    // odoo-node builds them: a JSON-RPC error carries Odoo's `data`, a
    // transport failure carries only a `code` (0 for the network, the HTTP
    // status otherwise).
    async function realOdooError(message: string, code?: number, data?: Record<string, unknown>) {
      const { OdooError } = await vi.importActual<typeof import("odoo-node")>("odoo-node");
      return new OdooError(message, code, data);
    }

    it("still reports a wrong login or API key as an authentication failure", async () => {
      // odoo-node's own error when Odoo answers `uid: false`.
      mockAuthenticate.mockRejectedValue(await realOdooError("Authentication failed"));
      const res = await probeIntegrationCredentials("odoo", validOdooCreds);
      expect(res).toMatchObject({ success: false });
      if (res.success) return;
      expect(res.reason).toMatch(/authentication failed/i);
      expect(res.transient).toBeFalsy();
    });

    it("reports an error Odoo itself raised during login as an authentication failure", async () => {
      mockAuthenticate.mockRejectedValue(
        await realOdooError("Access Denied", 200, { name: "odoo.exceptions.AccessDenied" })
      );
      const res = await probeIntegrationCredentials("odoo", validOdooCreds);
      if (res.success) throw new Error("expected failure");
      expect(res.reason).toMatch(/authentication failed/i);
      expect(res.transient).toBeFalsy();
    });

    // An http:// Odoo URL behind Caddy's or Traefik's default HTTP→HTTPS
    // redirect: odoo-node 0.3.1 refuses to follow it and says so. That is a
    // URL problem; calling it a bad API key sends the admin to fix the wrong
    // thing, and a non-transient result flags the connection auth_failed.
    it.each([
      [
        "a refused redirect",
        "Odoo answered with a redirect (HTTP 307); enter the address Odoo is served from",
        307,
      ],
      ["an HTTP error from a proxy", "HTTP 502: Bad Gateway", 502],
      ["a network failure", "fetch failed", 0],
    ])("does not call %s an authentication failure", async (_label, message, code) => {
      mockAuthenticate.mockRejectedValue(await realOdooError(message, code));
      const res = await probeIntegrationCredentials("odoo", validOdooCreds);
      if (res.success) throw new Error("expected failure");
      expect(res.reason).not.toMatch(/authentication failed/i);
      expect(res.reason).toContain(message);
      expect(res.transient).toBe(true);
    });

    it("does not call a non-JSON-RPC answer an authentication failure", async () => {
      mockAuthenticate.mockRejectedValue(
        await realOdooError("Response is not JSON-RPC (HTTP 200, text/plain)", 200)
      );
      const res = await probeIntegrationCredentials("odoo", validOdooCreds);
      if (res.success) throw new Error("expected failure");
      expect(res.reason).not.toMatch(/authentication failed/i);
      expect(res.reason).toContain("not a JSON-RPC response (HTTP 200, text/plain)");
      expect(res.transient).toBe(true);
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

    it("returns transient:true when the mail-host guard refuses the stored host, keeping its message", async () => {
      // testImapLogin runs the guard itself, so a refused host arrives here as
      // a MailHostBlockedError. It is a configuration problem: the stored
      // password may be perfectly good, so it must not flip auth_failed.
      const { MailHostBlockedError } = await import("@/lib/integrations/mail-host-guard");
      mockTestImapLogin.mockRejectedValue(
        new MailHostBlockedError(
          "Blocked: this host resolves to a private network address. Set ALLOW_PRIVATE_MAIL_HOSTS=1 to allow an on-premise mail server."
        )
      );

      const res = await probeIntegrationCredentials("imap", validImapCreds);

      expect(res).toEqual({
        success: false,
        transient: true,
        reason: expect.stringContaining("ALLOW_PRIVATE_MAIL_HOSTS=1"),
      });
      expect(mockTestSmtpVerify).not.toHaveBeenCalled();
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
});
