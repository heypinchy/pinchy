import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/navigation", () => ({
  redirect: vi.fn((url: string) => {
    throw new Error(`REDIRECT:${url}`);
  }),
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue({}),
}));

const mockGetSession = vi.fn();
vi.mock("@/lib/auth", () => ({
  getSession: (...args: unknown[]) => mockGetSession(...args),
}));

vi.mock("@/components/usage-dashboard", () => ({
  UsageDashboard: () => <div data-testid="usage-dashboard">Usage Dashboard</div>,
}));

vi.mock("@/lib/enterprise", () => ({
  isEnterprise: vi.fn().mockResolvedValue(false),
}));

import UsagePage from "@/app/(app)/usage/page";

describe("UsagePage (server component)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects non-admin users to /", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "user-1", role: "member" },
    });

    await expect(UsagePage()).rejects.toThrow("REDIRECT:/");
  });

  it("redirects unauthenticated users to /", async () => {
    mockGetSession.mockResolvedValue(null);

    await expect(UsagePage()).rejects.toThrow("REDIRECT:/");
  });

  it("renders UsageDashboard for admin users", async () => {
    mockGetSession.mockResolvedValue({
      user: { id: "admin-1", role: "admin" },
    });

    const result = await UsagePage();
    expect(result).toBeDefined();
  });
});
