import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeNextRequest, routeContext } from "@/test-helpers/route";
import { mockSession } from "@/test-helpers/auth";

/**
 * GET /api/data-directories/children — one level of the folder tree below a
 * `/data` mount (#1269). The filesystem rules (symlinks, `..`, the root
 * boundary) are unit-tested against a real temp tree in
 * `lib/data-subdirectories.test.ts`; this suite covers what the ROUTE owns:
 * who may ask, how the query string is read, and how each refusal maps onto a
 * status.
 */

const { mockGetSession, mockList } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockList: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  auth: { api: { getSession: mockGetSession } },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/data-subdirectories", () => ({
  listDataSubdirectories: mockList,
}));

import { GET } from "@/app/api/data-directories/children/route";

function get(query: string) {
  return GET(
    makeNextRequest(`http://localhost/api/data-directories/children${query}`),
    routeContext()
  );
}

describe("GET /api/data-directories/children", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(mockSession());
  });

  it("returns the folder's subfolders", async () => {
    mockList.mockResolvedValue({
      ok: true,
      truncated: false,
      directories: [{ path: "/data/suppliers/food", name: "food" }],
    });

    const response = await get("?path=%2Fdata%2Fsuppliers");

    expect(response.status).toBe(200);
    expect(mockList).toHaveBeenCalledWith("/data/suppliers");
    expect(await response.json()).toEqual({
      directories: [{ path: "/data/suppliers/food", name: "food" }],
      truncated: false,
    });
  });

  it("decodes the query string exactly once", async () => {
    mockList.mockResolvedValue({ ok: false, reason: "not_listable" });

    // `%252e%252e` decodes once to the literal `%2e%2e` — a folder name. The
    // route must hand that literal on, not decode it again into `..`.
    await get("?path=/data/suppliers/%252e%252e/%252e%252e/etc");

    expect(mockList).toHaveBeenCalledWith("/data/suppliers/%2e%2e/%2e%2e/etc");
  });

  it("refuses an encoded `..` that climbs out of /data before touching the filesystem", async () => {
    const response = await get("?path=/data/%2e%2e/etc");

    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("refuses a path outside /data before touching the filesystem", async () => {
    for (const path of ["/etc", "/database/x", "relative/dir", "/data/x\0y"]) {
      const response = await get(`?path=${encodeURIComponent(path)}`);
      expect(response.status).toBe(400);
    }
    expect(mockList).not.toHaveBeenCalled();
  });

  it("answers 400 without a path", async () => {
    const response = await get("");
    expect(response.status).toBe(400);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("answers 400 when the listing refuses the path", async () => {
    mockList.mockResolvedValue({ ok: false, reason: "invalid_path" });
    const response = await get("?path=/data");
    expect(response.status).toBe(400);
  });

  it("answers 404 for a folder it cannot list (missing, a file, or a symlink)", async () => {
    mockList.mockResolvedValue({ ok: false, reason: "not_listable" });
    const response = await get("?path=/data/suppliers/escape");
    expect(response.status).toBe(404);
  });

  it("is admin-only: folder names below a mount are not every member's business", async () => {
    mockGetSession.mockResolvedValue(mockSession({ user: { role: "member" } }));
    const response = await get("?path=/data/suppliers");
    expect(response.status).toBe(403);
    expect(mockList).not.toHaveBeenCalled();
  });

  it("answers 401 without a session", async () => {
    mockGetSession.mockResolvedValue(null);
    const response = await get("?path=/data/suppliers");
    expect(response.status).toBe(401);
  });
});
