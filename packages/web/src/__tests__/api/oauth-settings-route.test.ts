import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

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
  const actual = await importOriginal();
  return {
    ...actual,
    getOAuthSettings: vi.fn(),
    saveOAuthSettings: vi.fn(),
  };
});

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { getOAuthSettings, saveOAuthSettings } from "@/lib/integrations/oauth-settings";
import { appendAuditLog } from "@/lib/audit";
import { after } from "next/server";

const adminSession = {
  user: { id: "admin-1", name: "Admin", role: "admin" },
};

const userSession = {
  user: { id: "user-1", name: "User", role: "member" },
};

describe("GET /api/settings/oauth", () => {
  let GET: typeof import("@/app/api/settings/oauth/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
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
    expect(body).toEqual({ configured: false, clientId: "" });
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
    });
    // Secret should NOT be returned
    expect(body.clientSecret).toBeUndefined();
  });
});

describe("POST /api/settings/oauth", () => {
  let POST: typeof import("@/app/api/settings/oauth/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
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

  it("returns 400 when clientSecret is missing", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(adminSession);

    const req = new NextRequest("http://localhost/api/settings/oauth", {
      method: "POST",
      body: JSON.stringify({ provider: "google", clientId: "id" }),
    });
    const response = await POST(req);
    expect(response.status).toBe(400);
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

    // Flush after() callbacks
    const afterCb = vi.mocked(after).mock.calls[0]?.[0];
    if (typeof afterCb === "function") await afterCb();

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "config.changed",
      detail: { key: "google_oauth_credentials", provider: "google" },
      outcome: "success",
    });
  });
});
