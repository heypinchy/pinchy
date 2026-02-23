import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mock @/db ────────────────────────────────────────────────────────────────
const findFirstMock = vi.fn();
const returningMock = vi.fn();
const valuesMock = vi.fn().mockReturnValue({ returning: returningMock });
const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
const setMock = vi.fn().mockReturnValue({ where: vi.fn() });
const updateMock = vi.fn().mockReturnValue({ set: setMock });

vi.mock("@/db", () => ({
  db: {
    query: {
      chatSessions: {
        findFirst: (...args: unknown[]) => findFirstMock(...args),
      },
    },
    insert: (...args: unknown[]) => insertMock(...args),
    update: (...args: unknown[]) => updateMock(...args),
  },
}));

vi.mock("@/db/schema", () => ({
  chatSessions: {
    id: "id",
    userId: "user_id",
    agentId: "agent_id",
    createdAt: "created_at",
    runtimeActivated: "runtime_activated",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((col, val) => ({ col, val, type: "eq" })),
  and: vi.fn((...args: unknown[]) => ({ args, type: "and" })),
  desc: vi.fn((col) => ({ col, type: "desc" })),
}));

import { getOrCreateSession, markSessionActivated } from "@/lib/chat-sessions";

describe("getOrCreateSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns existing session if one exists for user+agent", async () => {
    const existing = {
      id: "s1",
      sessionKey: "key-123",
      userId: "u1",
      agentId: "a1",
      runtimeActivated: false,
    };
    findFirstMock.mockResolvedValue(existing);

    const result = await getOrCreateSession("u1", "a1");

    expect(result).toEqual(existing);
    expect(result.sessionKey).toBe("key-123");
    expect(insertMock).not.toHaveBeenCalled();
  });

  it("does not insert when an existing session is found", async () => {
    const existing = {
      id: "s1",
      sessionKey: "key-456",
      userId: "u1",
      agentId: "a1",
      runtimeActivated: false,
    };
    findFirstMock.mockResolvedValue(existing);

    await getOrCreateSession("u1", "a1");

    expect(insertMock).not.toHaveBeenCalled();
  });

  it("creates a new session if none exists", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const newSession = {
      id: "s2",
      sessionKey: "new-key",
      userId: "u1",
      agentId: "a1",
      runtimeActivated: false,
    };
    returningMock.mockResolvedValue([newSession]);

    const result = await getOrCreateSession("u1", "a1");

    expect(result).toEqual(newSession);
    expect(result.sessionKey).toBe("new-key");
    expect(insertMock).toHaveBeenCalled();
  });

  it("inserts with correct userId and agentId", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const newSession = {
      id: "s3",
      sessionKey: "key-789",
      userId: "user-42",
      agentId: "agent-7",
      runtimeActivated: false,
    };
    returningMock.mockResolvedValue([newSession]);

    await getOrCreateSession("user-42", "agent-7");

    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "user-42",
        agentId: "agent-7",
      })
    );
  });

  it("generates per-user sessionKey including userId and agentId", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const newSession = {
      id: "s4",
      sessionKey: "user:u1:agent:a1",
      userId: "u1",
      agentId: "a1",
      runtimeActivated: false,
    };
    returningMock.mockResolvedValue([newSession]);

    await getOrCreateSession("u1", "a1");

    const passedValues = valuesMock.mock.calls[0][0];
    expect(passedValues.sessionKey).toBe("user:u1:agent:a1");
  });

  it("generates different sessionKeys for different users on same agent", async () => {
    findFirstMock.mockResolvedValue(undefined);
    returningMock.mockResolvedValue([
      { id: "s-a", sessionKey: "user:userA:agent:a1", userId: "userA", agentId: "a1", runtimeActivated: false },
    ]);
    await getOrCreateSession("userA", "a1");

    vi.clearAllMocks();
    findFirstMock.mockResolvedValue(undefined);
    returningMock.mockResolvedValue([
      { id: "s-b", sessionKey: "user:userB:agent:a1", userId: "userB", agentId: "a1", runtimeActivated: false },
    ]);
    await getOrCreateSession("userB", "a1");

    const passedValues = valuesMock.mock.calls[0][0];
    expect(passedValues.sessionKey).toBe("user:userB:agent:a1");
  });

  it("returns runtimeActivated from existing session", async () => {
    const existing = {
      id: "s1",
      sessionKey: "key-123",
      userId: "u1",
      agentId: "a1",
      runtimeActivated: true,
    };
    findFirstMock.mockResolvedValue(existing);

    const result = await getOrCreateSession("u1", "a1");

    expect(result.runtimeActivated).toBe(true);
  });

  it("returns runtimeActivated=false for new sessions", async () => {
    findFirstMock.mockResolvedValue(undefined);
    const newSession = {
      id: "s6",
      sessionKey: "new-key",
      userId: "u1",
      agentId: "a1",
      runtimeActivated: false,
    };
    returningMock.mockResolvedValue([newSession]);

    const result = await getOrCreateSession("u1", "a1");

    expect(result.runtimeActivated).toBe(false);
  });

  it("queries with correct user and agent filters", async () => {
    findFirstMock.mockResolvedValue(undefined);
    returningMock.mockResolvedValue([
      { id: "s5", sessionKey: "k", userId: "u1", agentId: "a1", runtimeActivated: false },
    ]);

    await getOrCreateSession("u1", "a1");

    expect(findFirstMock).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.any(Object),
        orderBy: expect.any(Object),
      })
    );
  });

  it("handles unique constraint conflict by falling back to existing session", async () => {
    const existingSession = {
      id: "s-existing",
      sessionKey: "agent:a1:main",
      userId: "u-other",
      agentId: "a1",
      runtimeActivated: true,
    };
    // First findFirst returns nothing (different userId), insert fails with constraint
    findFirstMock
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(existingSession);
    const uniqueError = new Error("duplicate key value violates unique constraint");
    (uniqueError as Error & { code: string }).code = "23505";
    returningMock.mockRejectedValue(uniqueError);

    const result = await getOrCreateSession("u1", "a1");

    expect(result).toEqual(existingSession);
  });
});

describe("markSessionActivated", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates runtimeActivated to true for the given session", async () => {
    const whereMock = vi.fn();
    setMock.mockReturnValue({ where: whereMock });

    await markSessionActivated("session-123");

    expect(updateMock).toHaveBeenCalled();
    expect(setMock).toHaveBeenCalledWith({ runtimeActivated: true });
    expect(whereMock).toHaveBeenCalled();
  });
});
