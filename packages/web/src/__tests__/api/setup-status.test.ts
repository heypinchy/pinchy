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

  it("should return true when at least one user exists", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "1",
      email: "admin@test.com",
      name: "Admin",
      emailVerified: null,
      image: null,
      passwordHash: "hashed",
      role: "admin",
    });
    const result = await isSetupComplete();
    expect(result).toBe(true);
  });

  it("GET route should return setupComplete status", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    const response = await GET();
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toEqual({ setupComplete: false });
  });
});
