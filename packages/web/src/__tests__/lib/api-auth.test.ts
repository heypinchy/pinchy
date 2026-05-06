import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockGetSession, mockHeaders } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockHeaders: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));

import { requireAdmin, withAuth, withAdmin } from "@/lib/api-auth";

describe("requireAdmin (api-auth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 response when session is null", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await requireAdmin();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(401);
  });

  it("returns 403 response when user is not admin", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", role: "member" },
      session: { expiresAt: "" },
    });

    const result = await requireAdmin();
    expect(result).toBeInstanceOf(NextResponse);
    expect((result as NextResponse).status).toBe(403);
  });

  it("returns session when user is admin", async () => {
    const session = {
      user: { id: "admin-1", role: "admin" },
      session: { expiresAt: "" },
    };
    mockGetSession.mockResolvedValue(session);

    const result = await requireAdmin();
    expect(result).not.toBeInstanceOf(NextResponse);
    expect(result).toEqual(session);
  });

  it("returns 403 with standardized 'Forbidden' body for non-admin", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", role: "member" },
      session: { expiresAt: "" },
    });

    const result = (await requireAdmin()) as NextResponse;
    expect(result.status).toBe(403);
    expect(await result.json()).toEqual({ error: "Forbidden" });
  });

  it("returns 401 with standardized 'Unauthorized' body when no session", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = (await requireAdmin()) as NextResponse;
    expect(result.status).toBe(401);
    expect(await result.json()).toEqual({ error: "Unauthorized" });
  });
});

describe("withAuth (api-auth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 with 'Unauthorized' body when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const handler = vi.fn();
    const wrapped = withAuth(handler);

    const req = new NextRequest("http://localhost/x");
    const res = await wrapped(req, {});

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes handler with session when authenticated", async () => {
    const session = {
      user: { id: "user-1", role: "member" },
      session: { expiresAt: "" },
    };
    mockGetSession.mockResolvedValue(session);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withAuth(handler);

    const req = new NextRequest("http://localhost/x");
    const ctx = { params: Promise.resolve({ id: "abc" }) };
    const res = await wrapped(req, ctx);

    expect(handler).toHaveBeenCalledWith(req, ctx, session);
    expect(res.status).toBe(200);
  });

  it("invokes handler with admin session too (no role gating)", async () => {
    const session = {
      user: { id: "admin-1", role: "admin" },
      session: { expiresAt: "" },
    };
    mockGetSession.mockResolvedValue(session);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withAuth(handler);

    await wrapped(new NextRequest("http://localhost/x"), {});
    expect(handler).toHaveBeenCalled();
  });
});

describe("withAdmin (api-auth)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns 401 'Unauthorized' when no session", async () => {
    mockGetSession.mockResolvedValue(null);
    const handler = vi.fn();
    const wrapped = withAdmin(handler);

    const res = await wrapped(new NextRequest("http://localhost/x"), {});

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 403 'Forbidden' when authenticated but not admin", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", role: "member" },
      session: { expiresAt: "" },
    });
    const handler = vi.fn();
    const wrapped = withAdmin(handler);

    const res = await wrapped(new NextRequest("http://localhost/x"), {});

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("invokes handler with admin session", async () => {
    const session = {
      user: { id: "admin-1", role: "admin" },
      session: { expiresAt: "" },
    };
    mockGetSession.mockResolvedValue(session);
    const handler = vi.fn().mockResolvedValue(NextResponse.json({ ok: true }));
    const wrapped = withAdmin(handler);

    const req = new NextRequest("http://localhost/x");
    const ctx = { params: Promise.resolve({ id: "abc" }) };
    const res = await wrapped(req, ctx);

    expect(handler).toHaveBeenCalledWith(req, ctx, session);
    expect(res.status).toBe(200);
  });
});
