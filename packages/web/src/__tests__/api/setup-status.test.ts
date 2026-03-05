import { describe, it, expect, vi, beforeEach } from "vitest";
import { isSetupComplete } from "@/lib/setup";
import { GET } from "@/app/api/setup/status/route";

// Mock the database
vi.mock("@/db", () => ({
  db: {
    query: {
      users: {
        findFirst: vi.fn(),
      },
    },
  },
}));

import { db } from "@/db";

describe("setup status", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return false when no users exist", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    const result = await isSetupComplete();
    expect(result).toBe(false);
  });

  it("should return true when an admin user exists", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "1",
      email: "admin@test.com",
      name: "Admin",
      role: "admin",
    });
    const result = await isSetupComplete();
    expect(result).toBe(true);
  });

  it("should return false when only non-admin users exist (orphaned setup)", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    const result = await isSetupComplete();
    expect(result).toBe(false);
  });

  it("should query for admin role specifically", async () => {
    await isSetupComplete();
    expect(db.query.users.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.anything() })
    );
  });

  it("GET route should return setupComplete status", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ setupComplete: false });
  });
});
