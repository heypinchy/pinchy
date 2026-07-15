import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @/db ────────────────────────────────────────────────────────────────
const findFirstMock = vi.fn();

vi.mock("@/db", () => ({
  db: {
    query: {
      agents: {
        findFirst: (...args: unknown[]) => findFirstMock(...args),
      },
    },
  },
}));

// ── Mock @/lib/personal-agent ───────────────────────────────────────────────
const createSmithersAgentMock = vi.fn();
vi.mock("@/lib/personal-agent", () => ({
  createSmithersAgent: (...args: unknown[]) => createSmithersAgentMock(...args),
}));

// ── Mock @/lib/settings ──────────────────────────────────────────────────────
const getSettingMock = vi.fn();
vi.mock("@/lib/settings", () => ({
  getSetting: (...args: unknown[]) => getSettingMock(...args),
}));

describe("seedDefaultAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns existing agent if one exists", async () => {
    const existingAgent = { id: "existing-1", name: "Smithers" };
    findFirstMock.mockResolvedValue(existingAgent);

    const { seedDefaultAgent } = await import("@/db/seed");
    const agent = await seedDefaultAgent("admin-1");

    expect(agent).toEqual(existingAgent);
    expect(createSmithersAgentMock).not.toHaveBeenCalled();
  });

  it("falls back to anthropic/claude-sonnet-4-6 when no default_provider is configured", async () => {
    findFirstMock.mockResolvedValue(undefined);
    getSettingMock.mockResolvedValue(null);
    const fakeAgent = {
      id: "agent-new",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-6",
      ownerId: "admin-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    createSmithersAgentMock.mockResolvedValue(fakeAgent);

    const { seedDefaultAgent } = await import("@/db/seed");
    const agent = await seedDefaultAgent("admin-1");

    expect(agent.name).toBe("Smithers");
    expect(createSmithersAgentMock).toHaveBeenCalledWith({
      model: "anthropic/claude-sonnet-4-6",
      ownerId: "admin-1",
      isPersonal: true,
      isAdmin: true,
    });
  });

  it("uses the configured default_provider's default model", async () => {
    findFirstMock.mockResolvedValue(undefined);
    getSettingMock.mockResolvedValue("ollama-local");
    const fakeAgent = {
      id: "agent-new",
      name: "Smithers",
      model: "ollama/llama3.2",
      ownerId: "admin-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    createSmithersAgentMock.mockResolvedValue(fakeAgent);

    const { seedDefaultAgent } = await import("@/db/seed");
    await seedDefaultAgent("admin-1");

    expect(createSmithersAgentMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: "ollama/llama3.2" })
    );
  });

  it("always creates a personal, admin-owned Smithers", async () => {
    // The whole contract, in one assertion. `ownerId` used to be optional, and
    // the `ownerId ?? null` branch behind it produced an ownerless,
    // non-personal, non-admin agent that no production path has ever created —
    // lib/setup.ts is the only caller and always passes the new admin's id.
    // The dead branch was mistaken for real behavior during PR #754's review,
    // which is why the parameter is now required.
    findFirstMock.mockResolvedValue(undefined);
    getSettingMock.mockResolvedValue(null);
    const fakeAgent = {
      id: "agent-owned",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-6",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    createSmithersAgentMock.mockResolvedValue(fakeAgent);

    const { seedDefaultAgent } = await import("@/db/seed");
    const agent = await seedDefaultAgent("user-1");

    expect(agent.ownerId).toBe("user-1");
    expect(createSmithersAgentMock).toHaveBeenCalledWith({
      model: "anthropic/claude-sonnet-4-6",
      ownerId: "user-1",
      isPersonal: true,
      isAdmin: true,
    });
  });

  it("does not create agent when one already exists", async () => {
    const existingAgent = { id: "existing-1", name: "Smithers" };
    findFirstMock.mockResolvedValue(existingAgent);

    const { seedDefaultAgent } = await import("@/db/seed");
    await seedDefaultAgent("admin-1");

    expect(createSmithersAgentMock).not.toHaveBeenCalled();
  });
});
