import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/auth", () => ({
  auth: vi.fn().mockResolvedValue({ user: { id: "1", email: "admin@test.com" } }),
}));

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
    vi.mocked(auth).mockResolvedValueOnce(null);

    const response = await GET();

    expect(response.status).toBe(401);
  });
});
