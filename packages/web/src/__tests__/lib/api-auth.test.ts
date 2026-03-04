import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

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

import { requireAdmin } from "@/lib/api-auth";

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
      user: { id: "user-1", role: "user" },
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
});
