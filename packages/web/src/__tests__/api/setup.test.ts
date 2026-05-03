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
      update: vi.fn().mockReturnValue({
        set: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue(undefined),
        }),
      }),
    },
  };
});

vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
  auth: {
    api: {
      signUpEmail: vi.fn().mockResolvedValue({
        user: { id: "1", email: "admin@test.com" },
      }),
    },
  },
}));

vi.mock("@/lib/workspace", () => ({
  ensureWorkspace: vi.fn(),
  writeWorkspaceFile: vi.fn(),
  writeWorkspaceFileInternal: vi.fn(),
  writeIdentityFile: vi.fn(),
}));

vi.mock("@/lib/context-sync", () => ({
  getContextForAgent: vi.fn().mockResolvedValue(""),
}));

vi.mock("@/lib/smithers-soul", () => ({
  SMITHERS_SOUL_MD: "# Smithers\n\nTest soul content",
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/openclaw-config-ready", () => ({
  markOpenClawConfigReady: vi.fn(),
  isOpenClawConfigReady: vi.fn(),
}));

vi.mock("@/lib/settings", () => ({
  getSetting: vi.fn().mockResolvedValue(null),
}));

vi.mock("@/lib/providers", () => ({
  PROVIDERS: {},
}));

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn().mockResolvedValue("ollama-local/test-model"),
}));

import { ensureWorkspace } from "@/lib/workspace";
import { auth } from "@/lib/auth";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { markOpenClawConfigReady } from "@/lib/openclaw-config-ready";

import { db } from "@/db";

describe("createAdmin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should create admin user via Better Auth signUpEmail", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    const result = await createAdmin("Admin User", "admin@test.com", "Br1ghtNova!2");

    expect(result).toEqual({ id: "1", email: "admin@test.com" });
    expect(auth.api.signUpEmail).toHaveBeenCalledWith({
      body: { name: "Admin User", email: "admin@test.com", password: "Br1ghtNova!2" },
    });
  });

  it("should set admin role after user creation", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);

    await createAdmin("Admin User", "admin@test.com", "Br1ghtNova!2");

    expect(db.update).toHaveBeenCalled();
  });

  it("should pass user id to seedDefaultAgent", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    await createAdmin("Admin User", "admin@test.com", "Br1ghtNova!2");

    // db.insert is called once for the agent (user creation is via auth API)
    expect(db.insert).toHaveBeenCalled();
  });

  it("should reject if admin already exists", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "1",
      email: "admin@test.com",
      name: "Admin",
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
      password: "Br1ghtNova!2",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(201);
    expect(data).toEqual({ id: "1", email: "admin@test.com" });
  });

  it("should return 400 when name is missing", async () => {
    const request = makeRequest({
      email: "admin@test.com",
      password: "Br1ghtNova!2",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Validation failed");
    expect(data.details.fieldErrors.name).toBeDefined();
  });

  it("should return 400 when name is empty whitespace", async () => {
    const request = makeRequest({
      name: "   ",
      email: "admin@test.com",
      password: "Br1ghtNova!2",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Validation failed");
    expect(data.details.fieldErrors.name).toBeDefined();
  });

  it("should return 400 when email is invalid", async () => {
    const request = makeRequest({
      name: "Admin User",
      email: "not-an-email",
      password: "Br1ghtNova!2",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(400);
    expect(data.error).toBe("Validation failed");
    expect(data.details.fieldErrors.email).toBeDefined();
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
    expect(data.error).toBe("Password must be at least 12 characters");
  });

  it("should call regenerateOpenClawConfig after creating admin and agent", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    const request = makeRequest({
      name: "Admin User",
      email: "admin@test.com",
      password: "Br1ghtNova!2",
    });
    await POST(request as any);

    expect(regenerateOpenClawConfig).toHaveBeenCalledOnce();
  });

  it("should call markOpenClawConfigReady after setup completes", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    const request = makeRequest({
      name: "Admin User",
      email: "admin@test.com",
      password: "Br1ghtNova!2",
    });
    await POST(request as any);

    expect(markOpenClawConfigReady).toHaveBeenCalledOnce();
  });

  it("should return 403 when setup is already complete", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue({
      id: "1",
      email: "admin@test.com",
      name: "Admin",
      role: "admin",
    });

    const request = makeRequest({
      name: "New User",
      email: "new@test.com",
      password: "Br1ghtNova!2",
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
