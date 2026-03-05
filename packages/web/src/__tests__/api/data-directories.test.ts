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

vi.mock("fs", () => {
  const mocks = {
    readFileSync: vi.fn(),
  };
  return { ...mocks, default: mocks };
});

import { readFileSync } from "fs";
import { GET } from "@/app/api/data-directories/route";

describe("GET /api/data-directories", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return directories from JSON file", async () => {
    vi.mocked(readFileSync).mockReturnValue(
      JSON.stringify({
        directories: [
          { path: "/data/documents", name: "documents" },
          { path: "/data/hr-docs", name: "hr-docs" },
        ],
      })
    );

    const response = await GET();
    const body = await response.json();

    expect(readFileSync).toHaveBeenCalledWith("/openclaw-config/data-directories.json", "utf-8");
    expect(body.directories).toEqual([
      { path: "/data/documents", name: "documents" },
      { path: "/data/hr-docs", name: "hr-docs" },
    ]);
  });

  it("should return empty array when JSON file does not exist", async () => {
    vi.mocked(readFileSync).mockImplementation(() => {
      throw new Error("ENOENT: no such file or directory");
    });

    const response = await GET();
    const body = await response.json();

    expect(body.directories).toEqual([]);
  });

  it("should return 401 without auth", async () => {
    const { auth } = await import("@/lib/auth");
    vi.mocked(auth.api.getSession).mockResolvedValueOnce(null);

    const response = await GET();

    expect(response.status).toBe(401);
  });
});
