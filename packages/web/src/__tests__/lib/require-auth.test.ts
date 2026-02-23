import { describe, it, expect, vi, beforeEach } from "vitest";

class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT: ${url}`);
  }
}

const { mockAuth, mockRedirect, mockFindFirst } = vi.hoisted(() => ({
  mockAuth: vi.fn(),
  mockRedirect: vi.fn().mockImplementation((url: string) => {
    throw new RedirectError(url);
  }),
  mockFindFirst: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  auth: mockAuth,
  authConfig: {},
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("@/db", () => ({
  db: {
    query: {
      users: {
        findFirst: mockFindFirst,
      },
    },
  },
}));

vi.mock("next-auth", () => ({
  default: vi.fn(() => ({
    handlers: { GET: vi.fn(), POST: vi.fn() },
    auth: vi.fn(),
    signIn: vi.fn(),
    signOut: vi.fn(),
  })),
}));

vi.mock("@auth/drizzle-adapter", () => ({
  DrizzleAdapter: vi.fn(),
}));

import { requireAuth } from "@/lib/require-auth";

describe("requireAuth", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to /login when auth() returns null", async () => {
    mockAuth.mockResolvedValue(null);

    await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT: /login");
  });

  it("redirects to /login when auth() returns an error object", async () => {
    mockAuth.mockResolvedValue({
      message: "There was a problem with the server configuration.",
    });

    await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT: /login");
  });

  it("redirects to /login when session has no user", async () => {
    mockAuth.mockResolvedValue({ expires: "2026-03-01T00:00:00.000Z" });

    await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT: /login");
  });

  it("returns the session when user exists in DB", async () => {
    const validSession = {
      user: { id: "1", email: "admin@test.com", name: "Admin" },
      expires: "2026-03-01T00:00:00.000Z",
    };
    mockAuth.mockResolvedValue(validSession);
    mockFindFirst.mockResolvedValue({ id: "1", email: "admin@test.com" });

    const result = await requireAuth();

    expect(mockRedirect).not.toHaveBeenCalled();
    expect(result).toEqual(validSession);
  });

  it("redirects to /login when user ID does not exist in DB (stale JWT)", async () => {
    const staleSession = {
      user: { id: "nonexistent-id", email: "old@test.com", name: "Gone" },
      expires: "2026-03-01T00:00:00.000Z",
    };
    mockAuth.mockResolvedValue(staleSession);
    mockFindFirst.mockResolvedValue(undefined);

    await expect(requireAuth()).rejects.toThrow("NEXT_REDIRECT: /login");
  });
});
