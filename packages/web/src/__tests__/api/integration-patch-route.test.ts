import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
  auth: { api: { getSession: (...args: unknown[]) => mockGetSession(...args) } },
}));

const mockEncrypt = vi.fn().mockReturnValue("encrypted-creds");
const mockDecrypt = vi.fn().mockReturnValue(
  JSON.stringify({
    url: "https://odoo.example.com",
    db: "prod",
    login: "admin",
    apiKey: "secret-key",
    uid: 2,
  })
);
vi.mock("@/lib/encryption", () => ({
  encrypt: (...args: unknown[]) => mockEncrypt(...args),
  decrypt: (...args: unknown[]) => mockDecrypt(...args),
  getOrCreateSecret: vi.fn().mockReturnValue(Buffer.alloc(32)),
}));

const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
  // Faithful stand-in for the real scrubEmails: email-shaped tokens become
  // <email-redacted>, everything else passes through unchanged.
  scrubEmails: (text: string) => text.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, "<email-redacted>"),
}));

const mockProbeIntegrationCredentials = vi.fn();
vi.mock("@/lib/integrations/probe", () => ({
  probeIntegrationCredentials: (...args: unknown[]) => mockProbeIntegrationCredentials(...args),
}));

const mockClearIntegrationAuthError = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/integrations/auth-state", () => ({
  clearIntegrationAuthError: (...args: unknown[]) => mockClearIntegrationAuthError(...args),
  setIntegrationAuthFailed: vi.fn().mockResolvedValue(undefined),
}));

const { mockUpdateSet, mockSelectWhere } = vi.hoisted(() => ({
  mockUpdateSet: vi.fn(),
  mockSelectWhere: vi.fn(),
}));

const mockOdooConnection = {
  id: "conn-1",
  type: "odoo",
  name: "Test Odoo",
  description: "Test connection",
  credentials: "encrypted-creds",
  data: null,
  status: "active",
  createdAt: new Date("2026-01-01"),
  updatedAt: new Date("2026-01-01"),
};

vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({
        where: mockSelectWhere,
      }),
    }),
    update: vi.fn().mockReturnValue({
      set: mockUpdateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ ...mockOdooConnection, name: "Test Odoo" }]),
        }),
      }),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  integrationConnections: { id: "id" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col: unknown, val: unknown) => ({ col, val })),
  and: vi.fn((...args: unknown[]) => ({ and: args })),
}));

vi.mock("@/lib/integrations/odoo-schema", () => {
  // The route calls odooCredentialsSchema.partial() to allow partial updates.
  // The partial schema accepts any subset of odoo fields (no required fields check).
  const partialSchema = {
    safeParse: (data: unknown) => {
      return { success: true, data };
    },
  };
  const odooCredentialsSchema = {
    partial: () => partialSchema,
    safeParse: (data: unknown) => {
      const d = data as Record<string, unknown>;
      if (
        typeof d.url === "string" &&
        d.url.startsWith("https://") &&
        d.db &&
        d.login &&
        d.apiKey
      ) {
        return { success: true, data: d };
      }
      return { success: false, error: { errors: [{ message: "Invalid credentials" }] } };
    },
  };
  return { odooCredentialsSchema };
});

vi.mock("@/lib/integrations/url-validation", () => ({
  validateExternalUrl: (url: string) => {
    if (url.startsWith("https://")) return { valid: true };
    return { valid: false, error: "URL must use HTTPS" };
  },
}));

vi.mock("@/lib/integrations/mask-credentials", () => ({
  maskConnectionCredentials: (_type: string, _creds: unknown, _decrypt: unknown) => ({
    url: "https://odoo.example.com",
    db: "prod",
    login: "admin",
  }),
}));

vi.mock("@/lib/integrations/oauth-settings", () => ({
  deleteOAuthSettings: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from "next/server";

function makeRequest(path: string, options?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(`http://localhost:7777${path}`, options);
}

const adminSession = { user: { id: "user-1", email: "admin@test.com", role: "admin" } };

const validOdooCredentials = {
  url: "https://odoo.example.com",
  db: "prod",
  login: "admin",
  apiKey: "secret-key",
  uid: 2,
};

describe("PATCH /api/integrations/[connectionId] — credential probe", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession);
    mockSelectWhere.mockResolvedValue([mockOdooConnection]);
    mockProbeIntegrationCredentials.mockResolvedValue({ success: true });
    mockDecrypt.mockReturnValue(JSON.stringify(validOdooCredentials));
    mockEncrypt.mockReturnValue("encrypted-creds");
  });

  it("PATCH with new credentials probes upstream and updates on success", async () => {
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const newCredentials = { ...validOdooCredentials, apiKey: "new-secret-key" };
    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: newCredentials }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    expect(response.status).toBe(200);
    // Probe was called with merged credentials
    expect(mockProbeIntegrationCredentials).toHaveBeenCalledWith(
      "odoo",
      expect.objectContaining({ apiKey: "new-secret-key" })
    );
    // DB update was called
    expect(mockUpdateSet).toHaveBeenCalled();
    // clearIntegrationAuthError was called
    expect(mockClearIntegrationAuthError).toHaveBeenCalledWith(
      expect.objectContaining({ connectionId: "conn-1" })
    );
    // Audit log for credentials_updated was written with fields
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.credentials_updated",
        resource: "integration:conn-1",
        detail: expect.objectContaining({
          fields: expect.arrayContaining(["apiKey"]),
        }),
        outcome: "success",
      })
    );
    // ONLY the credentials_updated audit fires for a credentials-only PATCH.
    // We deliberately do NOT emit an additional integration.updated event for
    // the credentials field — that would produce two audit rows per mutation
    // and force CISO filters to deduplicate.
    expect(mockAppendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "integration.updated" })
    );
  });

  it("PATCH with both name AND credentials emits BOTH integration.updated and integration.credentials_updated", async () => {
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({
          name: "Renamed Odoo",
          credentials: { ...validOdooCredentials, apiKey: "rotated-key" },
        }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    // integration.updated for the name change
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "integration.updated",
        detail: expect.objectContaining({
          changes: expect.objectContaining({ name: { from: "Test Odoo", to: "Renamed Odoo" } }),
        }),
      })
    );
    // The integration.updated diff must NOT include credentials — that gets
    // its own dedicated event so the change types stay separable in the log.
    const updatedCall = mockAppendAuditLog.mock.calls.find(
      (c) => (c[0] as { eventType?: string }).eventType === "integration.updated"
    );
    const updatedDetail = (updatedCall?.[0] as { detail: { changes: Record<string, unknown> } })
      .detail;
    expect(updatedDetail.changes).not.toHaveProperty("credentials");

    // Separate integration.credentials_updated event still fires
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "integration.credentials_updated" })
    );
  });

  it("PATCH with bad new credentials returns 400 with reason and writes nothing", async () => {
    mockProbeIntegrationCredentials.mockResolvedValue({
      success: false,
      reason: "Access denied",
    });

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: validOdooCredentials }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toContain("Access denied");
    // db.update should NOT have been called
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("PATCH on google connection rejects credentials field", async () => {
    const googleConnection = {
      ...mockOdooConnection,
      id: "conn-google-1",
      type: "google",
    };
    mockSelectWhere.mockResolvedValueOnce([googleConnection]);

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-google-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: { accessToken: "x" } }),
      }),
      { params: Promise.resolve({ connectionId: "conn-google-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    expect(body.error).toMatch(/Google|OAuth|Reconnect/i);
    // Probe should not have been called
    expect(mockProbeIntegrationCredentials).not.toHaveBeenCalled();
    // DB update should not have been called
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("PATCH on microsoft connection rejects credentials field with the same Reconnect guidance as google", async () => {
    const microsoftConnection = {
      ...mockOdooConnection,
      id: "conn-microsoft-1",
      type: "microsoft",
    };
    mockSelectWhere.mockResolvedValueOnce([microsoftConnection]);

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-microsoft-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: { accessToken: "x" } }),
      }),
      { params: Promise.resolve({ connectionId: "conn-microsoft-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(400);
    // Must NOT fall through to the generic "Unknown connection type" branch —
    // microsoft is an OAuth provider just like google and needs the same
    // actionable "use Reconnect" guidance, not a misleading unknown-type error.
    expect(body.error).not.toMatch(/Unknown connection type/i);
    expect(body.error).toMatch(/Microsoft|OAuth|Reconnect/i);
    // Probe should not have been called
    expect(mockProbeIntegrationCredentials).not.toHaveBeenCalled();
    // DB update should not have been called
    expect(mockUpdateSet).not.toHaveBeenCalled();
  });

  it("PATCH with only name (no credentials) skips probe and updates normally", async () => {
    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ name: "New Name" }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    expect(response.status).toBe(200);
    // Probe should NOT have been called
    expect(mockProbeIntegrationCredentials).not.toHaveBeenCalled();
    // DB update was still called (for name change)
    expect(mockUpdateSet).toHaveBeenCalled();
    // No credentials_updated audit log
    expect(mockAppendAuditLog).not.toHaveBeenCalledWith(
      expect.objectContaining({ eventType: "integration.credentials_updated" })
    );
  });

  it("persists freshCredentials returned by probe (e.g. new uid after login change)", async () => {
    // When the user changes their Odoo login, the stored uid becomes stale.
    // The probe re-authenticates and returns the fresh uid; the route must
    // merge that into the encrypted credentials so future syncs use it.
    mockProbeIntegrationCredentials.mockResolvedValue({
      success: true,
      freshCredentials: { uid: 99 },
    });

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({
          credentials: { ...validOdooCredentials, login: "new-user", apiKey: "new-key" },
        }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );

    // encrypt() must have been called with JSON containing the FRESH uid (99),
    // not the stale stored uid (2).
    const encryptedPayload = mockEncrypt.mock.calls[0]?.[0] as string;
    const persistedCreds = JSON.parse(encryptedPayload);
    expect(persistedCreds.uid).toBe(99);
    expect(persistedCreds.login).toBe("new-user");
    expect(persistedCreds.apiKey).toBe("new-key");
  });

  describe("imap connections", () => {
    const mockImapConnection = {
      ...mockOdooConnection,
      id: "conn-imap-1",
      type: "imap",
      name: "Team Mailbox",
    };
    const existingImapCredentials = {
      imapHost: "imap.example.com",
      imapPort: 993,
      smtpHost: "smtp.example.com",
      smtpPort: 587,
      username: "team@example.com",
      password: "old-app-password",
      security: "tls",
    };

    beforeEach(() => {
      mockSelectWhere.mockResolvedValue([mockImapConnection]);
      mockDecrypt.mockReturnValue(JSON.stringify(existingImapCredentials));
      mockUpdateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([mockImapConnection]),
        }),
      });
    });

    it("PATCH with a valid partial merges, probes, clears the auth error, and returns 200", async () => {
      const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

      const response = await PATCH(
        makeRequest("/api/integrations/conn-imap-1", {
          method: "PATCH",
          body: JSON.stringify({ credentials: { password: "new-app-password" } }),
        }),
        { params: Promise.resolve({ connectionId: "conn-imap-1" }) }
      );

      expect(response.status).toBe(200);
      // Probe was called with the merged blob (existing fields + new password),
      // and ports stay numeric so the plugin's strict typeof-number shape holds.
      expect(mockProbeIntegrationCredentials).toHaveBeenCalledWith(
        "imap",
        expect.objectContaining({
          imapHost: "imap.example.com",
          imapPort: 993,
          smtpPort: 587,
          username: "team@example.com",
          password: "new-app-password",
        })
      );
      // Persisted blob keeps numeric ports.
      const encryptedPayload = mockEncrypt.mock.calls[0]?.[0] as string;
      const persisted = JSON.parse(encryptedPayload);
      expect(persisted.imapPort).toBe(993);
      expect(persisted.smtpPort).toBe(587);
      expect(persisted.password).toBe("new-app-password");
      // Auth error cleared + dedicated credentials_updated audit row with key NAMES only.
      expect(mockClearIntegrationAuthError).toHaveBeenCalledWith(
        expect.objectContaining({ connectionId: "conn-imap-1" })
      );
      expect(mockAppendAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: "integration.credentials_updated",
          detail: expect.objectContaining({ fields: ["password"] }),
          outcome: "success",
        })
      );
    });

    it("PATCH omitting password keeps the existing password via merge", async () => {
      const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

      await PATCH(
        makeRequest("/api/integrations/conn-imap-1", {
          method: "PATCH",
          body: JSON.stringify({ credentials: { imapHost: "imap2.example.com" } }),
        }),
        { params: Promise.resolve({ connectionId: "conn-imap-1" }) }
      );

      const encryptedPayload = mockEncrypt.mock.calls[0]?.[0] as string;
      const persisted = JSON.parse(encryptedPayload);
      expect(persisted.imapHost).toBe("imap2.example.com");
      // Untouched password preserved from the decrypted existing blob.
      expect(persisted.password).toBe("old-app-password");
    });

    it("PATCH with an out-of-range port returns 400 structured validation and writes nothing", async () => {
      const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

      const response = await PATCH(
        makeRequest("/api/integrations/conn-imap-1", {
          method: "PATCH",
          body: JSON.stringify({ credentials: { imapPort: 999999 } }),
        }),
        { params: Promise.resolve({ connectionId: "conn-imap-1" }) }
      );

      expect(response.status).toBe(400);
      // Must not fall through to the "Unknown connection type: imap" branch.
      const body = await response.json();
      expect(JSON.stringify(body)).not.toMatch(/Unknown connection type/i);
      expect(mockProbeIntegrationCredentials).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });

    it("PATCH with senderName merges it into the encrypted credentials blob", async () => {
      const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

      const response = await PATCH(
        makeRequest("/api/integrations/conn-imap-1", {
          method: "PATCH",
          body: JSON.stringify({ credentials: { senderName: "Team Support" } }),
        }),
        { params: Promise.resolve({ connectionId: "conn-imap-1" }) }
      );

      expect(response.status).toBe(200);
      expect(mockProbeIntegrationCredentials).toHaveBeenCalledWith(
        "imap",
        expect.objectContaining({ senderName: "Team Support" })
      );
      const encryptedPayload = mockEncrypt.mock.calls[0]?.[0] as string;
      const persisted = JSON.parse(encryptedPayload);
      expect(persisted.senderName).toBe("Team Support");
      // Existing fields are preserved via merge.
      expect(persisted.imapHost).toBe("imap.example.com");
    });

    it("scrubs an email-shaped connection name from the credentials_updated audit detail", async () => {
      // IMAP connections default their name to the mailbox address at create
      // time. That email-shaped name must not propagate raw into the
      // append-only audit row when credentials are later edited.
      const emailNamedConn = { ...mockImapConnection, name: "team@example.com" };
      mockSelectWhere.mockResolvedValue([emailNamedConn]);
      mockUpdateSet.mockReturnValue({
        where: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([emailNamedConn]),
        }),
      });

      const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

      await PATCH(
        makeRequest("/api/integrations/conn-imap-1", {
          method: "PATCH",
          body: JSON.stringify({ credentials: { password: "new-app-password" } }),
        }),
        { params: Promise.resolve({ connectionId: "conn-imap-1" }) }
      );

      const credCall = mockAppendAuditLog.mock.calls.find(
        (c) => (c[0] as { eventType?: string }).eventType === "integration.credentials_updated"
      );
      expect(credCall).toBeDefined();
      expect(JSON.stringify(credCall![0].detail)).not.toContain("team@example.com");
      expect(credCall![0].detail.name).toBe("<email-redacted>");
    });

    it("PATCH with a CR/LF senderName returns 400 and writes nothing", async () => {
      const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

      const response = await PATCH(
        makeRequest("/api/integrations/conn-imap-1", {
          method: "PATCH",
          body: JSON.stringify({ credentials: { senderName: "x\r\nBcc: evil@example.com" } }),
        }),
        { params: Promise.resolve({ connectionId: "conn-imap-1" }) }
      );

      expect(response.status).toBe(400);
      expect(mockProbeIntegrationCredentials).not.toHaveBeenCalled();
      expect(mockUpdateSet).not.toHaveBeenCalled();
    });
  });

  it("returns 409 when credentials were updated concurrently (optimistic lock)", async () => {
    // Simulate concurrent update: db.update returns 0 rows
    mockUpdateSet.mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    });

    const { PATCH } = await import("@/app/api/integrations/[connectionId]/route");

    const response = await PATCH(
      makeRequest("/api/integrations/conn-1", {
        method: "PATCH",
        body: JSON.stringify({ credentials: validOdooCredentials }),
      }),
      { params: Promise.resolve({ connectionId: "conn-1" }) }
    );
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toMatch(/concurrent/i);
    // Probe still ran before the write
    expect(mockProbeIntegrationCredentials).toHaveBeenCalled();
  });
});
