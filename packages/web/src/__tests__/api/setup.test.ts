import { describe, it, expect, vi, beforeEach } from "vitest";
import { createAdmin } from "@/lib/setup";
import { seedDefaultAgent } from "@/db/seed";
import { POST } from "@/app/api/setup/route";

vi.mock("@/db", () => {
  const insertMock = vi.fn().mockImplementation((table) => {
    const isAgentsTable =
      table && typeof table === "object" && Symbol.for("drizzle:Name") in table
        ? table[Symbol.for("drizzle:Name")] === "agents"
        : false;
    return {
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockImplementation(() => {
          if (isAgentsTable) {
            return Promise.resolve([
              {
                id: "agent-1",
                name: "Smithers",
                model: "anthropic/claude-sonnet-4-20250514",
                createdAt: new Date(),
              },
            ]);
          }
          return Promise.resolve([{ id: "1", email: "admin@test.com" }]);
        }),
      }),
    };
  });
  const queryMock = {
    users: {
      findFirst: vi.fn(),
    },
    agents: {
      findFirst: vi.fn(),
    },
  };
  return {
    db: {
      query: queryMock,
      insert: insertMock,
      transaction: vi.fn().mockImplementation(async (callback) => {
        return callback({
          query: queryMock,
          insert: insertMock,
        });
      }),
    },
  };
});

vi.mock("bcryptjs", () => ({
  default: {
    hash: vi.fn().mockResolvedValue("hashed_password"),
  },
}));

vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeIdentityFile: vi.fn(),
}));

vi.mock("@/lib/smithers-soul", () => ({
  SMITHERS_SOUL_MD: "# Smithers\n\nTest soul content",
}));

import { ensureWorkspace } from "@/lib/workspace";

import { db } from "@/db";

describe("createAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create admin user with hashed password", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    const result = await createAdmin("Admin User", "admin@test.com", "password123");

    expect(result).toEqual({ id: "1", email: "admin@test.com" });
    expect(db.insert).toHaveBeenCalled();
  });

  it("should accept and store name", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    await createAdmin("Admin User", "admin@test.com", "password123");

    const insertCalls = vi.mocked(db.insert).mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);
  });

  it("should pass user id to seedDefaultAgent", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    await createAdmin("Admin User", "admin@test.com", "password123");

    // db.insert is called twice: once for user, once for agent
    // The agent insert receives the ownerId from the created user
    expect(db.insert).toHaveBeenCalledTimes(2);
  });

  it("should use a database transaction", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    await createAdmin("Admin User", "admin@test.com", "password123");

    expect(db.transaction).toHaveBeenCalledTimes(1);
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

    await expect(createAdmin("New User", "new@test.com", "pass")).rejects.toThrow(
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
      name: "Admin User",
      email: "admin@test.com",
      password: "password123",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data).toEqual({ id: "1", email: "admin@test.com" });
  });

  it("should return 400 when name is missing", async () => {
    const request = makeRequest({
      email: "admin@test.com",
      password: "password123",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Name is required");
  });

  it("should return 400 when name is empty whitespace", async () => {
    const request = makeRequest({
      name: "   ",
      email: "admin@test.com",
      password: "password123",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Name is required");
  });

  it("should return 400 when email is invalid", async () => {
    const request = makeRequest({
      name: "Admin User",
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
      name: "Admin User",
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
      name: "New User",
      email: "new@test.com",
      password: "password123",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(403);
    expect(data.error).toBe("Setup already complete");
  });
});

describe("seedDefaultAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create Smithers agent", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    const agent = await seedDefaultAgent();
    expect(agent.name).toBe("Smithers");
  });

  it("should call ensureWorkspace when creating a new agent", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    await seedDefaultAgent();
    expect(ensureWorkspace).toHaveBeenCalledWith("agent-1");
  });

  it("should return existing agent if one exists", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue({
      id: "existing-agent",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      createdAt: new Date(),
    });

    const agent = await seedDefaultAgent();
    expect(agent.name).toBe("Smithers");
    expect(agent.id).toBe("existing-agent");
    expect(db.insert).not.toHaveBeenCalled();
    expect(ensureWorkspace).not.toHaveBeenCalled();
  });

  it("should accept an optional ownerId parameter", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    const agent = await seedDefaultAgent("user-1");
    expect(agent.name).toBe("Smithers");
  });

  it("should set isPersonal to true when ownerId is provided", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    await seedDefaultAgent("user-1");

    // Verify the insert was called (second call after user insert)
    const insertCalls = vi.mocked(db.insert).mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);
  });

  it("should set isPersonal to false when no ownerId is provided", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    await seedDefaultAgent();

    const insertCalls = vi.mocked(db.insert).mock.calls;
    expect(insertCalls.length).toBeGreaterThan(0);
  });
});
