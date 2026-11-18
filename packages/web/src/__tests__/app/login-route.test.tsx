// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({ getSession: (...a: unknown[]) => mockGetSession(...a) }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));

// /login never redirects on its own: a signed-in visitor is asked whether to
// continue or to sign in as someone else (the decision on #1275), so that an
// invite or password-reset "Sign in" in a browser where somebody else is still
// signed in does not drop the new person into that account.
const mockRedirect = vi.fn();
vi.mock("next/navigation", () => ({ redirect: (u: string) => mockRedirect(u) }));
vi.mock("@/app/login/login-form", () => ({
  default: () => <form aria-label="Sign in form" />,
}));

const mockLeaveAccount = vi.fn();
vi.mock("@/lib/account-switch", () => ({
  leaveAccount: () => mockLeaveAccount(),
}));

import LoginRoute from "@/app/login/page";

const SESSION = { user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com" } };

async function visit(returnTo?: string | string[]) {
  const ui = await LoginRoute({
    searchParams: Promise.resolve(returnTo === undefined ? {} : { returnTo }),
  });
  return render(ui);
}

function continueLink() {
  return screen.getByRole("link", { name: /continue/i });
}

describe("/login route (server)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("tells a signed-in user who they are signed in as, without redirecting", async () => {
    mockGetSession.mockResolvedValue(SESSION);
    await visit();
    expect(screen.getByText(/Ada Lovelace/)).toBeInTheDocument();
    expect(screen.getByText(/ada@example\.com/)).toBeInTheDocument();
    expect(screen.queryByRole("form", { name: "Sign in form" })).not.toBeInTheDocument();
    expect(mockRedirect).not.toHaveBeenCalled();
  });

  it("offers Continue into the app", async () => {
    mockGetSession.mockResolvedValue(SESSION);
    await visit();
    expect(continueLink()).toHaveAttribute("href", "/");
  });

  it("points Continue at a safe returnTo", async () => {
    mockGetSession.mockResolvedValue(SESSION);
    await visit("/chat/abc");
    expect(continueLink()).toHaveAttribute("href", "/chat/abc");
  });

  it.each(["//evil.com", "https://evil.com", "/\\evil.com"])(
    "ignores unsafe returnTo %s",
    async (bad) => {
      mockGetSession.mockResolvedValue(SESSION);
      await visit(bad);
      expect(continueLink()).toHaveAttribute("href", "/");
    }
  );

  it("ignores a repeated returnTo parameter", async () => {
    mockGetSession.mockResolvedValue(SESSION);
    await visit(["/a", "/b"]);
    expect(continueLink()).toHaveAttribute("href", "/");
  });

  it("signs out when the visitor wants to sign in as someone else", async () => {
    mockGetSession.mockResolvedValue(SESSION);
    await visit();
    await userEvent.click(screen.getByRole("button", { name: /sign in as someone else/i }));
    expect(mockLeaveAccount).toHaveBeenCalledTimes(1);
  });

  it("renders the form when signed out", async () => {
    mockGetSession.mockResolvedValue(null);
    await visit();
    expect(screen.getByRole("form", { name: "Sign in form" })).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /continue/i })).not.toBeInTheDocument();
  });

  it("renders the form when the session has no user (stale cookie)", async () => {
    mockGetSession.mockResolvedValue({});
    await visit();
    expect(screen.getByRole("form", { name: "Sign in form" })).toBeInTheDocument();
  });
});
