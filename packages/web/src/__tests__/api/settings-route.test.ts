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

vi.mock("@/lib/settings", () => ({
  getAllSettings: vi.fn().mockResolvedValue([]),
  setSetting: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { auth } from "@/lib/auth";
import { getAllSettings } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";
import { after } from "next/server";

describe("GET /api/settings", () => {
  let GET: typeof import("@/app/api/settings/route").GET;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/settings/route");
    GET = mod.GET;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET();
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const response = await GET();
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("returns settings when user is admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    vi.mocked(getAllSettings).mockResolvedValueOnce([
      { key: "default_provider", value: "anthropic", encrypted: false },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toEqual([{ key: "default_provider", value: "anthropic", encrypted: false }]);
  });

  it("masks encrypted values", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);
    vi.mocked(getAllSettings).mockResolvedValueOnce([
      { key: "anthropic_api_key", value: "sk-secret", encrypted: true },
    ]);

    const response = await GET();
    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body[0].value).toBe("••••••••");
  });
});

describe("POST /api/settings", () => {
  let POST: typeof import("@/app/api/settings/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import("@/app/api/settings/route");
    POST = mod.POST;
  });

  it("returns 401 when not authenticated", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "foo", value: "bar" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(401);

    const body = await response.json();
    expect(body.error).toBe("Unauthorized");
  });

  it("returns 403 when user is not admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "user-1", role: "member" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "foo", value: "bar" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(403);

    const body = await response.json();
    expect(body.error).toBe("Forbidden");
  });

  it("saves setting when user is admin", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const { setSetting } = await import("@/lib/settings");

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "default_provider", value: "openai" }),
    });
    const response = await POST(request);
    expect(response.status).toBe(200);

    expect(setSetting).toHaveBeenCalledWith("default_provider", "openai", false);
  });

  it("schedules the audit log write via after() instead of fire-and-forget", async () => {
    vi.mocked(auth.api.getSession).mockResolvedValueOnce({
      user: { id: "admin-1", role: "admin" },
      expires: "",
    } as any);

    const request = new NextRequest("http://localhost/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: "default_provider", value: "openai" }),
    });

    await POST(request);

    // The route must use next/server's after() so the audit log call is
    // properly scheduled and any errors flow through Next's error handler
    // instead of being swallowed by .catch(() => {}).
    expect(after).toHaveBeenCalledTimes(1);
    expect(appendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        actorType: "user",
        actorId: "admin-1",
        eventType: "config.changed",
        detail: { key: "default_provider" },
      })
    );
  });
});
