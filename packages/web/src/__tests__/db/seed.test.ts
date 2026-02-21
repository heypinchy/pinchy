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

describe("seedDefaultAgent", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns existing agent if one exists", async () => {
    const existingAgent = { id: "existing-1", name: "Smithers" };
    findFirstMock.mockResolvedValue(existingAgent);

    const { seedDefaultAgent } = await import("@/db/seed");
    const agent = await seedDefaultAgent();

    expect(agent).toEqual(existingAgent);
    expect(createSmithersAgentMock).not.toHaveBeenCalled();
  });

  it("creates a new agent when none exists", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const fakeAgent = {
      id: "agent-new",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: null,
      isPersonal: false,
      createdAt: new Date(),
    };
    createSmithersAgentMock.mockResolvedValue(fakeAgent);

    const { seedDefaultAgent } = await import("@/db/seed");
    const agent = await seedDefaultAgent();

    expect(agent.name).toBe("Smithers");
    expect(createSmithersAgentMock).toHaveBeenCalledWith({
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: null,
      isPersonal: false,
    });
  });

  it("passes ownerId and isPersonal when ownerId is provided", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const fakeAgent = {
      id: "agent-owned",
      name: "Smithers",
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
      createdAt: new Date(),
    };
    createSmithersAgentMock.mockResolvedValue(fakeAgent);

    const { seedDefaultAgent } = await import("@/db/seed");
    const agent = await seedDefaultAgent("user-1");

    expect(agent.ownerId).toBe("user-1");
    expect(createSmithersAgentMock).toHaveBeenCalledWith({
      model: "anthropic/claude-sonnet-4-20250514",
      ownerId: "user-1",
      isPersonal: true,
    });
  });

  it("does not create agent when one already exists", async () => {
    const existingAgent = { id: "existing-1", name: "Smithers" };
    findFirstMock.mockResolvedValue(existingAgent);

    const { seedDefaultAgent } = await import("@/db/seed");
    await seedDefaultAgent();

    expect(createSmithersAgentMock).not.toHaveBeenCalled();
  });
});
