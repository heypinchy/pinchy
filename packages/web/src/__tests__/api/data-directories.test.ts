import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", () => {
  const mockGetSession = vi.fn().mockResolvedValue({ user: { id: "1", email: "admin@test.com" } });
  return {
    getSession: mockGetSession,
    auth: {
      api: {
        getSession: mockGetSession,
      },
    },
  };
});

const mockListDataMounts = vi.fn();
vi.mock("@/lib/data-subdirectories", () => ({
  listDataMounts: (...args: unknown[]) => mockListDataMounts(...args),
}));

import { GET } from "@/app/api/data-directories/route";
import { makeNextRequest, routeContext } from "@/test-helpers/route";

describe("GET /api/data-directories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the folders under /data as they are right now", async () => {
    mockListDataMounts.mockResolvedValue([
      { path: "/data/documents", name: "documents" },
      { path: "/data/hr-docs", name: "hr-docs" },
    ]);

    const response = await GET(makeNextRequest(), routeContext());
    const body = await response.json();

    expect(body.directories).toEqual([
      { path: "/data/documents", name: "documents" },
      { path: "/data/hr-docs", name: "hr-docs" },
    ]);
  });

  // The list used to come from a file the OpenClaw container wrote at
  // start-up, so a renamed or deleted mount stayed on offer until that
  // container restarted (#1363). Asking on every request is the fix.
  it("asks for the folders again on every request instead of caching them", async () => {
    mockListDataMounts.mockResolvedValueOnce([{ path: "/data/old-name", name: "old-name" }]);
    mockListDataMounts.mockResolvedValueOnce([{ path: "/data/new-name", name: "new-name" }]);

    await GET(makeNextRequest(), routeContext());
    const second = await (await GET(makeNextRequest(), routeContext())).json();

    expect(mockListDataMounts).toHaveBeenCalledTimes(2);
    expect(second.directories).toEqual([{ path: "/data/new-name", name: "new-name" }]);
  });

  it("returns an empty list when nothing is mounted", async () => {
    mockListDataMounts.mockResolvedValue([]);

    const response = await GET(makeNextRequest(), routeContext());
    const body = await response.json();

    expect(body.directories).toEqual([]);
  });

  it("should return 401 without auth", async () => {
    const { auth } = await import("@/lib/auth");
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET(makeNextRequest(), routeContext());

    expect(response.status).toBe(401);
    expect(mockListDataMounts).not.toHaveBeenCalled();
  });
});
