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
vi.mock("@/lib/integrations/imap-probe", () => ({
  testImapLogin: (...args: unknown[]) => mockTestImapLogin(...args),
  testSmtpVerify: (...args: unknown[]) => mockTestSmtpVerify(...args),
  friendlyError: (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    const lower = message.toLowerCase();
    if (lower.includes("auth") || lower.includes("535")) {
      return "Authentication failed — check the username and password";
    }
    if (lower.includes("timed out") || lower.includes("timeout")) {
      return "Connection timed out — check the host and port";
    }
    if (lower.includes("econnrefused") || lower.includes("enotfound")) {
      return "Could not connect to the server — check the host and port";
    }
    return "Connection failed — check your settings and try again";
  },
}));

import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { probeBraveApiKey } from "@/lib/integrations/brave-probe";
import { probeIntegrationCredentials } from "@/lib/integrations/probe";

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
