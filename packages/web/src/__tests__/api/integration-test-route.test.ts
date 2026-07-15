import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockDecrypt = vi.fn();
const mockEncrypt = vi.fn().mockReturnValue("encrypted-creds");
vi.mock("@/lib/encryption", () => ({
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

const mockSelectWhere = vi.fn();
const mockUpdateSet = vi.fn();
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockSelectWhere,
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: mockUpdateSet.mockReturnValue({
        where: vi.fn().mockResolvedValue(undefined),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
}));

const mockProbeIntegrationCredentials = vi.fn();
vi.mock("@/lib/integrations/probe", () => ({
  probeIntegrationCredentials: (...args: unknown[]) => mockProbeIntegrationCredentials(...args),
}));

const mockClearIntegrationAuthError = vi.fn();
const mockSetIntegrationAuthFailed = vi.fn();
vi.mock("@/lib/integrations/auth-state", () => ({
  clearIntegrationAuthError: (...args: unknown[]) => mockClearIntegrationAuthError(...args),
  setIntegrationAuthFailed: (...args: unknown[]) => mockSetIntegrationAuthFailed(...args),
}));

// odoo-node mock (needed because route still imports OdooClient for uid self-heal)
vi.mock("odoo-node", () => {
  function OdooClient() {}
  OdooClient.authenticate = vi.fn().mockResolvedValue(2);
  return { OdooClient };
});

vi.mock("@/lib/integrations/odoo-schema", () => ({
  odooCredentialsSchema: {
    safeParse: vi.fn().mockReturnValue({
      success: true,
      data: {
        url: "https://odoo.example.com",
        db: "prod",
        login: "admin",
        apiKey: "secret-key",
        uid: 2,
      },
    }),
  },
}));

const mockIsTokenExpired = vi.fn();
vi.mock("@/lib/integrations/oauth-token", () => ({
  isTokenExpired: (...args: unknown[]) => mockIsTokenExpired(...args),
}));

class FakeOAuthSettingsMissingError extends Error {
  constructor(readonly provider: string) {
    super(`${provider} OAuth settings not configured`);
    this.name = "OAuthSettingsMissingError";
  }
}

const mockRefreshMicrosoftCredentials = vi.fn();
vi.mock("@/lib/integrations/microsoft-refresh", () => ({
  refreshMicrosoftCredentials: (...args: unknown[]) => mockRefreshMicrosoftCredentials(...args),
  OAuthSettingsMissingError: FakeOAuthSettingsMissingError,
}));

import { NextRequest } from "next/server";

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };

const mockConnection = {
  id: "conn-1",
  type: "odoo",
  name: "Test Odoo",
  credentials: "encrypted-creds",
  status: "active",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const decryptedOdooCreds = {
  url: "https://odoo.example.com",
  db: "prod",
  login: "admin",
  apiKey: "secret-key",
  uid: 2,
};

const mockMicrosoftConnection = {
  id: "conn-ms",
  type: "microsoft",
  name: "Test Mailbox",
  credentials: "encrypted-ms-creds",
  status: "active",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

const staleMicrosoftCreds = {
  accessToken: "stale-access-token",
  refreshToken: "stale-refresh-token",
  expiresAt: new Date(Date.now() - 60_000).toISOString(),
};

const refreshedMicrosoftCreds = {
  accessToken: "refreshed-access-token",
  refreshToken: "refreshed-refresh-token",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
};

function makeRequest(path: string, options?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost:7777${path}`, options);
}

describe("POST /api/integrations/[connectionId]/test — auth state flipping", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockDecrypt.mockReturnValue(JSON.stringify(decryptedOdooCreds));
    mockSelectWhere.mockResolvedValue([mockConnection]);
    mockClearIntegrationAuthError.mockResolvedValue(undefined);
    mockSetIntegrationAuthFailed.mockResolvedValue(undefined);
  });

  it("calls clearIntegrationAuthError with connectionId and actor when probe succeeds", async () => {
    mockProbeIntegrationCredentials.mockResolvedValue({ success: true });

    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockClearIntegrationAuthError).toHaveBeenCalledWith({
      connectionId: "conn-1",
      actor: { type: "user", id: "user-1" },
    });
    expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
  });

  it("calls setIntegrationAuthFailed with connectionId, reason, and actor when probe fails", async () => {
    mockProbeIntegrationCredentials.mockResolvedValue({
      success: false,
      reason: "Authentication failed",
    });

    const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

    const response = await POST(makeRequest("/api/integrations/conn-1/test", { method: "POST" }), {
      params: Promise.resolve({ connectionId: "conn-1" }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(false);
    expect(body.error).toBe("Authentication failed");
    expect(mockSetIntegrationAuthFailed).toHaveBeenCalledWith({
      connectionId: "conn-1",
      reason: "Authentication failed",
      actor: { type: "user", id: "user-1" },
    });
    expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
  });

  describe("Microsoft: pre-refresh expired tokens + transient-failure handling", () => {
    beforeEach(() => {
      mockSelectWhere.mockResolvedValue([mockMicrosoftConnection]);
      mockDecrypt.mockReturnValue(JSON.stringify(staleMicrosoftCreds));
      mockIsTokenExpired.mockReturnValue(false);
    });

    it("refreshes an expired Microsoft access token before probing and does not flip status on success", async () => {
      mockIsTokenExpired.mockReturnValue(true);
      mockRefreshMicrosoftCredentials.mockResolvedValue(refreshedMicrosoftCreds);
      mockProbeIntegrationCredentials.mockResolvedValue({ success: true });

      const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

      const response = await POST(
        makeRequest("/api/integrations/conn-ms/test", { method: "POST" }),
        { params: Promise.resolve({ connectionId: "conn-ms" }) }
      );
      const body = await response.json();

      expect(mockRefreshMicrosoftCredentials).toHaveBeenCalledWith("conn-ms", staleMicrosoftCreds);
      // The probe must run against the freshly refreshed credentials, not the stale ones.
      expect(mockProbeIntegrationCredentials).toHaveBeenCalledWith(
        "microsoft",
        expect.objectContaining({ accessToken: "refreshed-access-token" })
      );
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockClearIntegrationAuthError).toHaveBeenCalledWith({
        connectionId: "conn-ms",
        actor: { type: "user", id: "user-1" },
      });
      expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
    });

    it("does not flip status to auth_failed when the probe reports a transient failure", async () => {
      mockProbeIntegrationCredentials.mockResolvedValue({
        success: false,
        transient: true,
        reason: "Microsoft Graph returned 503 — temporary error, try again.",
      });

      const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

      const response = await POST(
        makeRequest("/api/integrations/conn-ms/test", { method: "POST" }),
        { params: Promise.resolve({ connectionId: "conn-ms" }) }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/temporary error/i);
      expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
      expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
    });

    it("still flips status to auth_failed when the probe reports a genuine (non-transient) auth failure", async () => {
      mockProbeIntegrationCredentials.mockResolvedValue({
        success: false,
        reason: "Access token expired or revoked. Please reconnect to Microsoft.",
      });

      const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

      const response = await POST(
        makeRequest("/api/integrations/conn-ms/test", { method: "POST" }),
        { params: Promise.resolve({ connectionId: "conn-ms" }) }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(mockSetIntegrationAuthFailed).toHaveBeenCalledWith({
        connectionId: "conn-ms",
        reason: "Access token expired or revoked. Please reconnect to Microsoft.",
        actor: { type: "user", id: "user-1" },
      });
    });

    it("flips status to auth_failed when the OAuth app is missing during a required refresh", async () => {
      mockIsTokenExpired.mockReturnValue(true);
      mockRefreshMicrosoftCredentials.mockRejectedValue(
        new FakeOAuthSettingsMissingError("Microsoft")
      );

      const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

      const response = await POST(
        makeRequest("/api/integrations/conn-ms/test", { method: "POST" }),
        { params: Promise.resolve({ connectionId: "conn-ms" }) }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/OAuth app is not configured/i);
      expect(mockSetIntegrationAuthFailed).toHaveBeenCalledWith({
        connectionId: "conn-ms",
        reason: expect.stringMatching(/OAuth app is not configured/i),
        actor: { type: "user", id: "user-1" },
      });
      // Must not have probed with stale credentials once we know the OAuth app is gone.
      expect(mockProbeIntegrationCredentials).not.toHaveBeenCalled();
    });
  });

  describe("imap: Test Connection on an existing connection", () => {
    const mockImapConnection = {
      id: "conn-imap",
      type: "imap",
      name: "Company Mailbox",
      credentials: "encrypted-imap-creds",
      status: "active",
      createdAt: new Date("2026-01-01"),
      updatedAt: new Date("2026-01-01"),
    };

    const storedImapCreds = {
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      username: "mailbox@example.com",
      password: "super-secret-app-password",
      security: "tls",
    };

    beforeEach(() => {
      mockSelectWhere.mockResolvedValue([mockImapConnection]);
      mockDecrypt.mockReturnValue(JSON.stringify(storedImapCreds));
    });

    it("clears auth error and does NOT flip to auth_failed when the imap probe succeeds (regression: healthy connection stayed marked auth_failed)", async () => {
      mockProbeIntegrationCredentials.mockResolvedValue({ success: true });

      const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

      const response = await POST(
        makeRequest("/api/integrations/conn-imap/test", { method: "POST" }),
        { params: Promise.resolve({ connectionId: "conn-imap" }) }
      );
      const body = await response.json();

      expect(mockProbeIntegrationCredentials).toHaveBeenCalledWith(
        "imap",
        expect.objectContaining(storedImapCreds)
      );
      expect(response.status).toBe(200);
      expect(body.success).toBe(true);
      expect(mockClearIntegrationAuthError).toHaveBeenCalledWith({
        connectionId: "conn-imap",
        actor: { type: "user", id: "user-1" },
      });
      expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
    });

    it("flips to auth_failed with a sensible reason on a genuine imap auth failure", async () => {
      mockProbeIntegrationCredentials.mockResolvedValue({
        success: false,
        reason: "Authentication failed — check the username and password",
      });

      const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

      const response = await POST(
        makeRequest("/api/integrations/conn-imap/test", { method: "POST" }),
        { params: Promise.resolve({ connectionId: "conn-imap" }) }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/authentication failed/i);
      expect(mockSetIntegrationAuthFailed).toHaveBeenCalledWith({
        connectionId: "conn-imap",
        reason: "Authentication failed — check the username and password",
        actor: { type: "user", id: "user-1" },
      });
      expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
    });

    it("does not flip to auth_failed when the imap probe reports a transient/connection error", async () => {
      mockProbeIntegrationCredentials.mockResolvedValue({
        success: false,
        transient: true,
        reason: "Could not connect to the server — check the host and port",
      });

      const { POST } = await import("@/app/api/integrations/[connectionId]/test/route");

      const response = await POST(
        makeRequest("/api/integrations/conn-imap/test", { method: "POST" }),
        { params: Promise.resolve({ connectionId: "conn-imap" }) }
      );
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.success).toBe(false);
      expect(body.error).toMatch(/could not connect/i);
      expect(mockSetIntegrationAuthFailed).not.toHaveBeenCalled();
      expect(mockClearIntegrationAuthError).not.toHaveBeenCalled();
    });
  });
});
