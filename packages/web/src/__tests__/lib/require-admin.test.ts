import { describe, it, expect, vi, beforeEach } from "vitest";

class RedirectError extends Error {
  url: string;
  constructor(url: string) {
    super(`NEXT_REDIRECT: ${url}`);
    this.url = url;
  }
}

const { mockGetSession, mockRedirect, mockHeaders } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockRedirect: vi.fn(),
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

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));

import { requireAdmin } from "@/lib/require-admin";

describe("requireAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation((url: string) => {
      throw new RedirectError(url);
    });
  });

  it("redirects to /login when no session", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT: /login");

    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("redirects to /login when session has no user id", async () => {
    mockGetSession.mockResolvedValue({
      user: { email: "a@b.com" },
      session: { expiresAt: "2026-03-01T00:00:00.000Z" },
    });

    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT: /login");

    expect(mockRedirect).toHaveBeenCalledWith("/login");
  });

  it("redirects to / when user role is not admin", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", email: "a@b.com", role: "user" },
      session: { expiresAt: "2026-03-01T00:00:00.000Z" },
    });

    await expect(requireAdmin()).rejects.toThrow("NEXT_REDIRECT: /");

    expect(mockRedirect).toHaveBeenCalledWith("/");
  });

  it("returns session when user role is admin", async () => {
    const adminSession = {
      user: { id: "user-1", email: "admin@test.com", name: "Admin", role: "admin" },
      session: { expiresAt: "2026-03-01T00:00:00.000Z" },
    };
    mockGetSession.mockResolvedValue(adminSession);

    const result = await requireAdmin();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toEqual(adminSession);
  });
});
