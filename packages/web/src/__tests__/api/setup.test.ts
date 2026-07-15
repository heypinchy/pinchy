import { describe, it, expect, expectTypeOf, vi, beforeEach } from "vitest";
import { createAdmin } from "@/lib/setup";
import { seedDefaultAgent } from "@/db/seed";
import { POST } from "@/app/api/setup/route";

// Rows handed to `db.insert(agents).values(...)`, newest last. Hoisted out of
// the insert mock so a test can assert the SHAPE of the agent it creates —
// without it, `values` is a fresh spy per call and unreachable from the test,
// which is why the seedDefaultAgent tests below could only ever assert "some
// insert happened". vi.hoisted because vi.mock's factory is lifted above the
// imports and would otherwise read this before initialization.
const { agentInsertRows } = vi.hoisted(() => ({
  agentInsertRows: [] as Record<string, unknown>[],
}));

vi.mock("@/db", () => {
  const insertMock = vi.fn().mockImplementation((table) => {
    const isAgentsTable =
      table && typeof table === "object" && Symbol.for("drizzle:Name") in table
        ? table[Symbol.for("drizzle:Name")] === "agents"
        : false;
    return {
      values: vi.fn().mockImplementation((row: Record<string, unknown>) => {
        if (isAgentsTable) agentInsertRows.push(row);
        return {
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
        };
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

vi.mock("@/lib/settings-timezone");

vi.mock("@/lib/providers", () => ({
  PROVIDERS: {},
}));

vi.mock("@/lib/provider-models", () => ({
  getDefaultModel: vi.fn().mockResolvedValue("ollama-local/test-model"),
}));

import { ensureWorkspace } from "@/lib/workspace";
import { auth } from "@/lib/auth";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { markOpenClawConfigReady, isOpenClawConfigReady } from "@/lib/openclaw-config-ready";

import { db } from "@/db";

// Full `db.query.users.findFirst()` / `db.query.agents.findFirst()` row
// shapes. Only the fields each test cares about vary; the rest are filled
// with realistic defaults so the fixtures stay in sync with the schema.
function makeDbUserRow(overrides: {
  id: string;
  email: string;
  name: string;
  role: "admin" | "member";
}) {
  return {
    ...overrides,
    emailVerified: true,
    image: null,
    banned: false,
    banReason: null,
    banExpires: null,
    context: null,
    auditPseudonym: "pseudonym-1",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
  };
}

function makeDbAgentRow(overrides: { id: string; name: string; model: string; createdAt: Date }) {
  return {
    ...overrides,
    templateId: null,
    pluginConfig: null,
    allowedTools: [],
    skills: [],
    ownerId: null,
    isPersonal: false,
    visibility: "restricted" as const,
    greetingMessage: "Hi, I'm Smithers.",
    tagline: null,
    starterPrompts: [],
    avatarSeed: null,
    personalityPresetId: null,
    deletedAt: null,
  };
}

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
    vi.mocked(db.query.users.findFirst).mockResolvedValue(
      makeDbUserRow({ id: "1", email: "admin@test.com", name: "Admin", role: "admin" })
    );

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

  it("should return 500 and not mark ready when regenerateOpenClawConfig fails", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(undefined);
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);
    vi.mocked(regenerateOpenClawConfig).mockRejectedValueOnce(
      new Error("disk full: cannot write openclaw.json")
    );

    const request = makeRequest({
      name: "Admin User",
      email: "admin@test.com",
      password: "Br1ghtNova!2",
    });
    const response = await POST(request as any);
    const data = await response.json();

    expect(response.status).toBe(500);
    expect(data.error).toMatch(/openclaw config/i);
    expect(markOpenClawConfigReady).not.toHaveBeenCalled();
  });

  it("should return 403 when setup is already complete and config is in place", async () => {
    vi.mocked(db.query.users.findFirst).mockResolvedValue(
      makeDbUserRow({ id: "1", email: "admin@test.com", name: "Admin", role: "admin" })
    );
    // Config was already written, so a retry is genuinely a no-op.
    vi.mocked(isOpenClawConfigReady).mockReturnValue(true);

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

  it("recovers in-process when the admin exists but the config was never written", async () => {
    // Prior setup POST created the admin + agent, but its regenerate threw, so
    // the config was never written and isOpenClawConfigReady is false.
    vi.mocked(db.query.users.findFirst).mockResolvedValue(
      makeDbUserRow({ id: "1", email: "admin@test.com", name: "Admin", role: "admin" })
    );
    vi.mocked(isOpenClawConfigReady).mockReturnValue(false);
    vi.mocked(regenerateOpenClawConfig).mockResolvedValueOnce(undefined);

    const request = makeRequest({
      name: "New User",
      email: "new@test.com",
      password: "Br1ghtNova!2",
    });
    const response = await POST(request as any);

    // The retry completes the config write instead of dead-ending at 403.
    expect(response.status).toBe(200);
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
    expect(markOpenClawConfigReady).toHaveBeenCalled();
  });

  it("coalesces concurrent recovery retries into a single config regeneration", async () => {
    // A flood of POSTs while in the (admin exists, config not ready) state must
    // not each kick off its own regenerateOpenClawConfig — that's an
    // unauthenticated resource-exhaustion vector. Concurrent recoveries share
    // one in-flight regeneration.
    vi.mocked(db.query.users.findFirst).mockResolvedValue(
      makeDbUserRow({ id: "1", email: "admin@test.com", name: "Admin", role: "admin" })
    );
    vi.mocked(isOpenClawConfigReady).mockReturnValue(false);
    // Each regeneration stays pending for a tick so all three POSTs reach the
    // recovery branch before any resolves — that's the window in which a guard
    // must coalesce them. A short real-timer delay (not microtasks) guarantees
    // they all arrive first, and resolves on its own so nothing hangs even when
    // the guard is missing (each POST just starts its own timer).
    vi.mocked(regenerateOpenClawConfig).mockImplementation(
      () => new Promise<void>((r) => setTimeout(r, 10))
    );

    const fire = () =>
      POST(makeRequest({ name: "X", email: "x@test.com", password: "Br1ghtNova!2" }) as any);
    const responses = await Promise.all([fire(), fire(), fire()]);

    expect(responses.every((r) => r.status === 200)).toBe(true);
    expect(regenerateOpenClawConfig).toHaveBeenCalledOnce();
  });
});

describe("seedDefaultAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    agentInsertRows.length = 0;
  });

  it("should create Smithers agent", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    const agent = await seedDefaultAgent("admin-1");
    expect(agent.name).toBe("Smithers");
  });

  it("should call ensureWorkspace when creating a new agent", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    await seedDefaultAgent("admin-1");
    expect(ensureWorkspace).toHaveBeenCalledWith("agent-1");
  });

  it("should return existing agent if one exists", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(
      makeDbAgentRow({
        id: "existing-agent",
        name: "Smithers",
        model: "anthropic/claude-sonnet-4-20250514",
        createdAt: new Date(),
      })
    );

    const agent = await seedDefaultAgent("admin-1");
    expect(agent.name).toBe("Smithers");
    expect(agent.id).toBe("existing-agent");
    expect(db.insert).not.toHaveBeenCalled();
    expect(ensureWorkspace).not.toHaveBeenCalled();
  });

  it("owns the agent it creates by the id it was given", async () => {
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    const agent = await seedDefaultAgent("user-1");

    expect(agent.name).toBe("Smithers");
    expect(agentInsertRows).toHaveLength(1);
    expect(agentInsertRows[0]).toMatchObject({ ownerId: "user-1" });
  });

  it("creates the admin's Smithers as a personal agent", async () => {
    // Was "should set isPersonal to false when no ownerId is provided", which
    // pinned a shape production has never produced: seedDefaultAgent runs once,
    // from the setup wizard, always with the freshly created admin's id. Its
    // body never checked isPersonal at all — it asserted only that *some*
    // insert had happened, so it would have passed for any shape whatsoever.
    vi.mocked(db.query.agents.findFirst).mockResolvedValue(undefined);

    await seedDefaultAgent("admin-1");

    expect(agentInsertRows).toHaveLength(1);
    expect(agentInsertRows[0]).toMatchObject({
      ownerId: "admin-1",
      isPersonal: true,
    });
  });

  it("takes ownerId as a required parameter", () => {
    // Replaces "should set isPersonal to false when no ownerId is provided".
    // That test called seedDefaultAgent() with no argument and asserted only
    // that *some* insert had happened — it never checked isPersonal, so it
    // passed for any shape, and what it actually pinned was a branch no
    // production path can reach (lib/setup.ts, the sole caller, always passes
    // the new admin's id). The ownerless shape it implied got cited as real
    // behavior during PR #754's review before anyone read the code.
    //
    // A compile-time check is the honest replacement: it holds the contract
    // that made the dead branch impossible, and re-adding the `?` breaks the
    // build rather than quietly resurrecting the trap.
    expectTypeOf(seedDefaultAgent).parameters.toEqualTypeOf<[string]>();
  });
});
