import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { mockSession } from "@/test-helpers/auth";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn();
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

vi.mock("@/lib/integrations/oauth-settings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/integrations/oauth-settings")>();
  return {
    ...actual,
    getOAuthSettings: vi.fn(),
    saveOAuthSettings: vi.fn(),
    deleteOAuthSettings: vi.fn(),
  };
});

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/integrations/oauth-preflight", () => ({
  validateMicrosoftTenant: vi.fn(),
}));

// The GET route counts integrationConnections of the provider's type for the
// blast-radius warning. Mock the select().from().where() chain to resolve to a
// single `[{ value: N }]` count row, mirroring drizzle's `count()` result.
const { mockCountWhere } = vi.hoisted(() => ({ mockCountWhere: vi.fn() }));
vi.mock("@/db", () => ({
  db: {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ where: mockCountWhere }),
    }),
  },
}));

import { auth } from "@/lib/auth";
import {
  getOAuthSettings,
  saveOAuthSettings,
  deleteOAuthSettings,
} from "@/lib/integrations/oauth-settings";
import { appendAuditLog } from "@/lib/audit";
import { validateMicrosoftTenant } from "@/lib/integrations/oauth-preflight";

const adminSession = mockSession({ user: { id: "admin-1", name: "Admin", role: "admin" } });

const userSession = mockSession({ user: { id: "user-1", name: "User", role: "member" } });

describe("GET /api/settings/oauth", () => {
  let GET: typeof import("@/app/api/settings/oauth/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCountWhere.mockResolvedValue([{ value: 0 }]);
    const mod = await import("@/app/api/settings/oauth/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=google");
    const response = await GET(req);
    expect(response.status).toBe(401);
  });

  it("returns 403 when not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(userSession);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=google");
    const response = await GET(req);
    expect(response.status).toBe(403);
  });

  it("returns 400 when provider query param is missing", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);

    const req = new NextRequest("http://localhost/api/settings/oauth");
    const response = await GET(req);
    expect(response.status).toBe(400);
  });

  it("returns 400 when provider is not supported", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=github");
    const response = await GET(req);
    expect(response.status).toBe(400);
  });

  it("returns configured: false when no settings exist", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=google");
    const response = await GET(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ configured: false, clientId: "", connectionCount: 0 });
  });

  it("returns configured: true with clientId when settings exist", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce({
      clientId: "my-client-id.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret123",
    });

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=google");
    const response = await GET(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({
      configured: true,
      clientId: "my-client-id.apps.googleusercontent.com",
      connectionCount: 0,
    });
    // Secret should NOT be returned
    expect(body.clientSecret).toBeUndefined();
  });

  it("returns the connection count for the provider's type", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce({
      clientId: "my-client-id.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret123",
    });
    mockCountWhere.mockResolvedValueOnce([{ value: 3 }]);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=google");
    const response = await GET(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.connectionCount).toBe(3);
  });

  it("returns connectionCount 0 when no connections exist and not configured", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce(null);
    mockCountWhere.mockResolvedValueOnce([{ value: 0 }]);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=google");
    const response = await GET(req);
    const body = await response.json();

    expect(body.configured).toBe(false);
    expect(body.connectionCount).toBe(0);
  });

  it("excludes pending placeholders from the connection count", async () => {
    // Recursively scans a drizzle-orm SQL condition's queryChunks for the
    // `ne(status, "pending")` exclusion — a `" <> "` operator chunk
    // immediately followed by the literal value "pending". This lets the
    // mock behave like a real filtered count instead of a hardcoded number,
    // so the assertion is causally tied to the actual where-clause the route
    // builds, not just a return-value stub.
    function excludesPending(node: unknown, depth = 0): boolean {
      if (depth > 10 || !node || typeof node !== "object") return false;
      const chunks = (node as { queryChunks?: unknown[] }).queryChunks;
      if (!Array.isArray(chunks)) return false;
      return chunks.some((chunk, i) => {
        if (!chunk || typeof chunk !== "object") return false;
        if ("value" in chunk) {
          const value = (chunk as { value: unknown }).value;
          if (Array.isArray(value) && value[0] === " <> ") {
            const next = chunks[i + 1] as { value?: unknown };
            return next?.value === "pending";
          }
        }
        return excludesPending(chunk, depth + 1);
      });
    }

    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce({
      clientId: "my-client-id.apps.googleusercontent.com",
      clientSecret: "GOCSPX-secret123",
    });

    // Simulate one real connection ("active") and one abandoned pending
    // placeholder for the same provider: a real query filtered by
    // `ne(status, "pending")` would only count the active row.
    mockCountWhere.mockImplementation((condition: unknown) =>
      Promise.resolve([{ value: excludesPending(condition) ? 1 : 2 }])
    );

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=google");
    const response = await GET(req);
    const body = await response.json();

    expect(body.connectionCount).toBe(1);
  });
});

describe("GET /api/settings/oauth — microsoft provider", () => {
  let GET: typeof import("@/app/api/settings/oauth/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockCountWhere.mockResolvedValue([{ value: 0 }]);
    const mod = await import("@/app/api/settings/oauth/route");
    GET = mod.GET;
  });

  it("returns configured: true when microsoft settings exist", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce({
      clientId: "ms-client",
      clientSecret: "ms-secret",
      tenantId: "my-tenant",
    });

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=microsoft");
    const response = await GET(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.configured).toBe(true);
    expect(body.clientId).toBe("ms-client");
    expect(body.clientSecret).toBeUndefined();
  });

  it("returns the stored tenantId for microsoft (without the secret)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce({
      clientId: "ms-client",
      clientSecret: "ms-secret",
      tenantId: "my-tenant",
    });

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=microsoft");
    const response = await GET(req);
    const body = await response.json();

    expect(body.tenantId).toBe("my-tenant");
    expect(body.clientSecret).toBeUndefined();
  });

  it("returns an empty tenantId for microsoft when none is stored", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce({
      clientId: "ms-client",
      clientSecret: "ms-secret",
    });

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=microsoft");
    const response = await GET(req);
    const body = await response.json();

    expect(body.tenantId).toBe("");
  });

  it("returns configured: false when microsoft settings do not exist", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=microsoft");
    const response = await GET(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ configured: false, clientId: "", connectionCount: 0 });
  });
});

describe("POST /api/settings/oauth", () => {
  let POST: typeof import("@/app/api/settings/oauth/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    // Default the tenant pre-flight check to "ok" so pre-existing tests in this
    // suite (written before the pre-flight check existed) that pass a tenantId
    // without caring about validation still exercise the save path unchanged.
    // The dedicated "microsoft tenant pre-flight" describe block below sets its
    // own return values per test.
    vi.mocked(validateMicrosoftTenant).mockResolvedValue({ ok: true });
    const mod = await import("@/app/api/settings/oauth/route");
    POST = mod.POST;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({ provider: "google", clientId: "id", clientSecret: "secret" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(401);
  });

  it("returns 403 when not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(userSession);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({ provider: "google", clientId: "id", clientSecret: "secret" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(403);
  });

  it("returns 400 when provider is missing", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({ clientId: "id", clientSecret: "secret" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
  });

  it("returns 400 when clientId is missing", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({ provider: "google", clientSecret: "secret" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
  });

  it("returns 400 when clientSecret is missing and no settings exist yet (first-time setup)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({ provider: "google", clientId: "id" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toMatch(/Client Secret is required when configuring a new app/i);
    expect(saveOAuthSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when clientSecret is an explicitly-sent empty string", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({ provider: "google", clientId: "id", clientSecret: "" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
  });

  it("reuses the stored clientSecret when omitted and settings already exist", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce({
      clientId: "old-client-id",
      clientSecret: "existing-secret",
    });
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({ provider: "google", clientId: "new-client-id" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ success: true });

    expect(saveOAuthSettings).toHaveBeenCalledWith("google", {
      clientId: "new-client-id",
      clientSecret: "existing-secret",
    });
  });

  it("saves settings and returns success", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "google",
        clientId: "my-client-id",
        clientSecret: "my-secret",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ success: true });

    expect(saveOAuthSettings).toHaveBeenCalledWith("google", {
      clientId: "my-client-id",
      clientSecret: "my-secret",
    });
  });

  it("logs an audit event after saving", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "google",
        clientId: "my-client-id",
        clientSecret: "my-secret",
      }),
    });
    await POST(req);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      resource: "integration:google-oauth",
      eventType: "config.changed",
      detail: { key: "google_oauth_credentials", provider: "google" },
      outcome: "success",
    });
  });

  it("POST with microsoft provider stores settings including tenantId", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "microsoft",
        clientId: "ms-client",
        clientSecret: "ms-secret",
        tenantId: "my-tenant",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ success: true });

    expect(saveOAuthSettings).toHaveBeenCalledWith("microsoft", {
      clientId: "ms-client",
      clientSecret: "ms-secret",
      tenantId: "my-tenant",
    });
  });

  it("POST with microsoft provider works without tenantId", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "microsoft",
        clientId: "ms-client",
        clientSecret: "ms-secret",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);

    expect(saveOAuthSettings).toHaveBeenCalledWith("microsoft", {
      clientId: "ms-client",
      clientSecret: "ms-secret",
    });
  });

  it("reuses the stored clientSecret for microsoft when omitted and settings already exist", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce({
      clientId: "old-ms-client",
      clientSecret: "existing-ms-secret",
      tenantId: "old-tenant",
    });
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "microsoft",
        clientId: "new-ms-client",
        tenantId: "new-tenant",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);

    expect(saveOAuthSettings).toHaveBeenCalledWith("microsoft", {
      clientId: "new-ms-client",
      clientSecret: "existing-ms-secret",
      tenantId: "new-tenant",
    });
  });

  it("returns 400 for microsoft when clientSecret is omitted and no settings exist yet", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(getOAuthSettings).mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({ provider: "microsoft", clientId: "ms-client" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toMatch(/Client Secret is required when configuring a new app/i);
    expect(saveOAuthSettings).not.toHaveBeenCalled();
  });

  it("POST with microsoft provider logs audit event", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "microsoft",
        clientId: "ms-client",
        clientSecret: "ms-secret",
        tenantId: "my-tenant",
      }),
    });
    await POST(req);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      resource: "integration:microsoft-oauth",
      eventType: "config.changed",
      detail: { key: "microsoft_oauth_credentials", provider: "microsoft" },
      outcome: "success",
    });
  });

  it("propagates the error when the audit write fails after saving (no silent fire-and-forget)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("audit db unavailable"));

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "google",
        clientId: "my-client-id",
        clientSecret: "my-secret",
      }),
    });

    // The settings save is idempotent, so an audit-write failure should
    // surface as a rejection (Next.js turns this into a 500) rather than
    // being silently dropped via a fire-and-forget after() callback.
    await expect(POST(req)).rejects.toThrow("audit db unavailable");
    expect(saveOAuthSettings).toHaveBeenCalled();
  });

  it("GET google provider still works (no regression)", async () => {
    // This is implicitly covered by the existing GET tests above,
    // but we add an explicit regression check here for the POST suite's completeness.
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "google",
        clientId: "g-client",
        clientSecret: "g-secret",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(saveOAuthSettings).toHaveBeenCalledWith("google", {
      clientId: "g-client",
      clientSecret: "g-secret",
    });
  });
});

describe("POST /api/settings/oauth — microsoft tenant pre-flight", () => {
  let POST: typeof import("@/app/api/settings/oauth/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/settings/oauth/route");
    POST = mod.POST;
  });

  it("returns 400 and does not save when the tenant validates as not_found", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(validateMicrosoftTenant).mockResolvedValueOnce({
      ok: false,
      reason: "not_found",
    });

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "microsoft",
        clientId: "ms-client",
        clientSecret: "ms-secret",
        tenantId: "bad-tenant-id",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);

    const body = await response.json();
    expect(body.error).toContain("bad-tenant-id");
    expect(body.error).toMatch(/tenant/i);
    expect(body.error).toMatch(/client/i);
    expect(saveOAuthSettings).not.toHaveBeenCalled();
  });

  it("saves and returns 200 when the tenant validates ok", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(validateMicrosoftTenant).mockResolvedValueOnce({ ok: true });
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "microsoft",
        clientId: "ms-client",
        clientSecret: "ms-secret",
        tenantId: "good-tenant-id",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ success: true });
    expect(saveOAuthSettings).toHaveBeenCalledWith("microsoft", {
      clientId: "ms-client",
      clientSecret: "ms-secret",
      tenantId: "good-tenant-id",
    });
  });

  it("does not call the tenant validator (or ignores its result) and saves when tenantId is blank", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "microsoft",
        clientId: "ms-client",
        clientSecret: "ms-secret",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(validateMicrosoftTenant).not.toHaveBeenCalled();
    expect(saveOAuthSettings).toHaveBeenCalledWith("microsoft", {
      clientId: "ms-client",
      clientSecret: "ms-secret",
    });
  });

  it("fails open (200, saved) when the tenant validator returns ok: 'unknown'", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(validateMicrosoftTenant).mockResolvedValueOnce({ ok: "unknown" });
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "microsoft",
        clientId: "ms-client",
        clientSecret: "ms-secret",
        tenantId: "some-tenant-id",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ success: true });
    expect(saveOAuthSettings).toHaveBeenCalledWith("microsoft", {
      clientId: "ms-client",
      clientSecret: "ms-secret",
      tenantId: "some-tenant-id",
    });
  });

  it("does not call the tenant validator for the google provider", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(saveOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({
        provider: "google",
        clientId: "g-client",
        clientSecret: "g-secret",
      }),
    });
    const response = await POST(req);
    expect(response.status).toBe(200);
    expect(validateMicrosoftTenant).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/settings/oauth", () => {
  let DELETE: typeof import("@/app/api/settings/oauth/route").DELETE;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/settings/oauth/route");
    DELETE = mod.DELETE;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=microsoft", {
      method: "DELETE",
    });
    const response = await DELETE(req);
    expect(response.status).toBe(401);
    expect(deleteOAuthSettings).not.toHaveBeenCalled();
  });

  it("returns 403 when not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(userSession);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=microsoft", {
      method: "DELETE",
    });
    const response = await DELETE(req);
    expect(response.status).toBe(403);
    expect(deleteOAuthSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when provider query param is missing", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "DELETE",
    });
    const response = await DELETE(req);
    expect(response.status).toBe(400);
    expect(deleteOAuthSettings).not.toHaveBeenCalled();
  });

  it("returns 400 when provider is not supported", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=github", {
      method: "DELETE",
    });
    const response = await DELETE(req);
    expect(response.status).toBe(400);
    expect(deleteOAuthSettings).not.toHaveBeenCalled();
  });

  it("deletes the provider's OAuth app settings and returns success", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(deleteOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=microsoft", {
      method: "DELETE",
    });
    const response = await DELETE(req);
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual({ success: true });

    expect(deleteOAuthSettings).toHaveBeenCalledWith("microsoft");
  });

  it("propagates the error when the audit write fails after resetting (no silent fire-and-forget)", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(deleteOAuthSettings).mockResolvedValueOnce(undefined);
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("audit db unavailable"));

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=microsoft", {
      method: "DELETE",
    });

    await expect(DELETE(req)).rejects.toThrow("audit db unavailable");
    expect(deleteOAuthSettings).toHaveBeenCalled();
  });

  it("logs an audit event after resetting", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);
    vi.mocked(deleteOAuthSettings).mockResolvedValueOnce(undefined);

    const req = new NextRequest("http://localhost/api/settings/oauth?provider=microsoft", {
      method: "DELETE",
    });
    await DELETE(req);

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      resource: "integration:microsoft-oauth",
      eventType: "config.changed",
      detail: { action: "oauth_app_reset", provider: "microsoft" },
      outcome: "success",
    });
  });
});
