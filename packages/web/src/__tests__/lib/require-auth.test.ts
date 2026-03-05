import { describe, it, expect, vi, beforeEach } from "vitest";

class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT: ${url}`);
  }
}

const { mockGetSession, mockRedirect, mockHeaders } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockRedirect: vi.fn().mockImplementation((url: string) => {
    throw new RedirectError(url);
  }),
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

import { requireAuth } from "@/lib/require-auth";

describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRedirect.mockImplementation((url: string) => {
      throw new RedirectError(url);
    });
  });

  it("redirects to /login when getSession returns null", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT: /login");
  });

  it("redirects to /login when session has no user", async () => {
    mockGetSession.mockResolvedValue({ session: { expiresAt: "2026-03-01" } });

    await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT: /login");
  });

  it("returns the session when user exists", async () => {
    const validSession = {
      user: { id: "1", email: "admin@test.com", name: "Admin" },
      session: { expiresAt: "2026-03-01" },
    };
    mockGetSession.mockResolvedValue(validSession);

    const result = await requireAuth();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toEqual(validSession);
  });
});
