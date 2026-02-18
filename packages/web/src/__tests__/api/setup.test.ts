import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAdmin } from "@/lib/setup";
import { POST } from "@/app/api/setup/route";

vi.mock("@/db", () => {
  const insertMock = vi.fn().mockReturnValue({
    values: vi.fn().mockReturnValue({
      returning: vi.fn().mockResolvedValue([{ id: "1", email: "admin@test.com" }]),
    }),
  });
  return {
    db: {
      query: {
        users: {
          findFirst: vi.fn(),
        },
      },
      insert: insertMock,
    },
  };
});

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("hashed_password"),
  },
}));

import { db } from "@/db";

describe("createAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create admin user with hashed password", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    const result = await createAdmin("admin@test.com", "password123");

    expect(result).toEqual({ id: "1", email: "admin@test.com" });
    expect(db.insert).toHaveBeenCalled();
  });

  it("should reject if admin already exists", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "1",
      email: "admin@test.com",
      name: "Admin",
      emailVerified: null,
      image: null,
      passwordHash: "hashed",
      role: "admin",
    });

    await expect(createAdmin("new@test.com", "pass")).rejects.toThrow(
      "Setup already complete"
    );
  });
});

describe("POST /api/setup", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRequest(body: Record<string, unknown>) {
    return new Request("http://localhost/api/setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  it("should return 201 with user data on success", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    const request = makeRequest({
      email: "admin@test.com",
      password: "password123",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data).toEqual({ id: "1", email: "admin@test.com" });
  });

  it("should return 400 when email is invalid", async () => {
    const request = makeRequest({
      email: "not-an-email",
      password: "password123",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("A valid email address is required");
  });

  it("should return 400 when password is too short", async () => {
    const request = makeRequest({
      email: "admin@test.com",
      password: "short",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Password must be at least 8 characters");
  });

  it("should return 403 when setup is already complete", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "1",
      email: "admin@test.com",
      name: "Admin",
      emailVerified: null,
      image: null,
      passwordHash: "hashed",
      role: "admin",
    });

    const request = makeRequest({
      email: "new@test.com",
      password: "password123",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe("Setup already complete");
  });
});
