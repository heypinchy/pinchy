import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockGetSession } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

import { validateWsSession } from "@/server/ws-auth";

describe("validateWsSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when no cookie header is provided", async () => {
    const result = await validateWsSession(undefined);

    expect(result).toBeNull();
    expect(mockGetSession).not.toHaveBeenCalled();
  });

  it("returns null when getSession returns null", async () => {
    mockGetSession.mockResolvedValue(null);

    const result = await validateWsSession("some_cookie=value");

    expect(result).toBeNull();
  });

  it("returns null when session has no user", async () => {
    mockGetSession.mockResolvedValue({ session: { expiresAt: "2026-03-01" } });

    const result = await validateWsSession("some_cookie=value");

    expect(result).toBeNull();
  });

  it("returns userId and userRole when session is valid", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-123", email: "admin@test.com", role: "admin" },
      session: { expiresAt: "2026-03-01" },
    });

    const result = await validateWsSession("better-auth.session_token=valid-token");

    expect(result).toEqual({ userId: "user-123", userRole: "admin" });
    expect(mockGetSession).toHaveBeenCalledWith({
      headers: expect.any(Headers),
    });
  });

  it("defaults userRole to 'user' when role is not set", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-456", email: "user@test.com" },
      session: { expiresAt: "2026-03-01" },
    });

    const result = await validateWsSession("better-auth.session_token=valid-token");

    expect(result).toEqual({ userId: "user-456", userRole: "user" });
  });

  it("returns null when getSession throws an error", async () => {
    mockGetSession.mockRejectedValue(new Error("Session error"));

    const result = await validateWsSession("better-auth.session_token=corrupt-token");

    expect(result).toBeNull();
  });

  it("passes cookie header to getSession via Headers object", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-789", role: "admin" },
      session: { expiresAt: "2026-03-01" },
    });

    await validateWsSession("better-auth.session_token=abc123; other=xyz");

    expect(mockGetSession).toHaveBeenCalledTimes(1);
    const callArgs = mockGetSession.mock.calls[0][0];
    expect(callArgs.headers).toBeInstanceOf(Headers);
    expect(callArgs.headers.get("cookie")).toBe("better-auth.session_token=abc123; other=xyz");
  });
});
