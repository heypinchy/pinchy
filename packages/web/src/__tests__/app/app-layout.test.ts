import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";

class RedirectError extends Error {
  constructor(public url: string) {
    super(`NEXT_REDIRECT: ${url}`);
  }
}

const {
  mockRedirect,
  mockHeaders,
  mockCookies,
  mockGetSession,
  mockIsSetupComplete,
  mockIsProviderConfigured,
  mockGetVisibleAgents,
} = vi.hoisted(() => ({
  mockRedirect: vi.fn().mockImplementation((url: string) => {
    throw new RedirectError(url);
  }),
  mockHeaders: vi.fn(),
  mockCookies: vi.fn().mockResolvedValue(undefined),
  mockGetSession: vi.fn(),
  mockIsSetupComplete: vi.fn().mockResolvedValue(true),
  mockIsProviderConfigured: vi.fn().mockResolvedValue(true),
  mockGetVisibleAgents: vi.fn().mockResolvedValue([]),
}));

vi.mock("next/navigation", () => ({
  redirect: mockRedirect,
}));

vi.mock("next/headers", () => ({
  headers: mockHeaders,
  cookies: mockCookies,
}));

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
}));

vi.mock("@/lib/setup", () => ({
  isSetupComplete: mockIsSetupComplete,
  isProviderConfigured: mockIsProviderConfigured,
}));

vi.mock("@/lib/visible-agents", () => ({
  getVisibleAgents: mockGetVisibleAgents,
}));

// The layout also renders a bunch of UI providers/components. None of them
// matter for this auth-guard test, so stub them out to keep this focused
// and avoid dragging in unrelated rendering concerns.
vi.mock("@/components/sidebar", () => ({ AppSidebar: () => null }));
vi.mock("@/components/app-shell", () => ({
  AppShell: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/agents-provider", () => ({
  AgentsProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/ui/sidebar", () => ({
  SidebarProvider: ({ children }: { children: React.ReactNode }) => children,
  SidebarInset: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/enterprise-banner", () => ({ EnterpriseBanner: () => null }));
vi.mock("@/components/insecure-banner", () => ({ InsecureBanner: () => null }));
vi.mock("@/components/dev-toolbar", () => ({ DevToolbar: () => null }));
vi.mock("@/components/chat-session-provider", () => ({
  ChatSessionProvider: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@/components/chat-session-mounts", () => ({ ChatSessionMounts: () => null }));

import AppLayout from "@/app/(app)/layout";

function headersWithPathname(pathname: string | null) {
  const h = new Headers();
  if (pathname) h.set("x-pathname", pathname);
  return h;
}

describe("(app) layout auth guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockIsSetupComplete.mockResolvedValue(true);
    mockIsProviderConfigured.mockResolvedValue(true);
    mockGetVisibleAgents.mockResolvedValue([]);
    mockCookies.mockResolvedValue(undefined);
    mockRedirect.mockImplementation((url: string) => {
      throw new RedirectError(url);
    });
  });

  it("redirects to /login with the encoded returnTo destination when there is no session", async () => {
    mockGetSession.mockResolvedValue(null);
    mockHeaders.mockResolvedValue(headersWithPathname("/share?share_id=abc"));

    const children = React.createElement("div", null, "child");

    await expect(AppLayout({ children })).rejects.toThrow(
      "NEXT_REDIRECT: /login?returnTo=%2Fshare%3Fshare_id%3Dabc"
    );
  });

  it("falls back to returnTo=/ when the captured pathname header is missing", async () => {
    mockGetSession.mockResolvedValue(null);
    mockHeaders.mockResolvedValue(headersWithPathname(null));

    const children = React.createElement("div", null, "child");

    await expect(AppLayout({ children })).rejects.toThrow("NEXT_REDIRECT: /login?returnTo=%2F");
  });

  it("redirects to /login even when a session has no user (defense in depth)", async () => {
    mockGetSession.mockResolvedValue({ session: { expiresAt: "2026-03-01" } });
    mockHeaders.mockResolvedValue(headersWithPathname("/agents"));

    const children = React.createElement("div", null, "child");

    await expect(AppLayout({ children })).rejects.toThrow(
      "NEXT_REDIRECT: /login?returnTo=%2Fagents"
    );
  });

  it("renders children without redirecting when a session is present", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "1", role: "member" },
      session: { expiresAt: "2026-03-01" },
    });
    mockHeaders.mockResolvedValue(headersWithPathname("/agents"));

    const children = React.createElement("div", { "data-testid": "child" }, "content");
    const result = await AppLayout({ children });

    expect(result).toBeTruthy();
    expect(mockRedirect).not.toHaveBeenCalled();
  });
});
