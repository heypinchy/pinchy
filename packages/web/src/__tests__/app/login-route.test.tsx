import { describe, it, expect, vi, beforeEach } from "vitest";

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT ${url}`);
  }
}
const mockRedirect = vi.fn((url: string) => {
  throw new RedirectError(url);
});
vi.mock("next/navigation", () => ({ redirect: (u: string) => mockRedirect(u) }));
vi.mock("@/app/login/login-form", () => ({ default: () => null }));

import LoginRoute from "@/app/login/page";

const SESSION = { user: { id: "u1" } };

async function visit(returnTo?: string | string[]) {
  return LoginRoute({ searchParams: Promise.resolve(returnTo === undefined ? {} : { returnTo }) });
}

describe("/login route (server)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects a signed-in user to /", async () => {
    mockGetSession.mockResolvedValue(SESSION);
    await expect(visit()).rejects.toThrow("NEXT_REDIRECT /");
  });

  it("redirects a signed-in user to a safe returnTo", async () => {
    mockGetSession.mockResolvedValue(SESSION);
    await expect(visit("/chat/abc")).rejects.toThrow("NEXT_REDIRECT /chat/abc");
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com"])(
    "ignores unsafe returnTo %s",
    async (bad) => {
      mockGetSession.mockResolvedValue(SESSION);
      await expect(visit(bad)).rejects.toThrow("NEXT_REDIRECT /");
    }
  );

  it("ignores a repeated returnTo parameter", async () => {
    mockGetSession.mockResolvedValue(SESSION);
    await expect(visit(["/a", "/b"])).rejects.toThrow("NEXT_REDIRECT /");
  });

  it("renders the form when signed out", async () => {
    mockGetSession.mockResolvedValue(null);
    await expect(visit()).resolves.toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("renders the form when the session has no user (stale cookie)", async () => {
    mockGetSession.mockResolvedValue({});
    await expect(visit()).resolves.toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
