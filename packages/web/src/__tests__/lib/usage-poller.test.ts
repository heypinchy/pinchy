import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRecordUsage = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/usage", () => ({
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));

const mockWhere = vi.fn();

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return {
        from: (table: { _table?: string }) => {
          mockFrom(table);
          if (table?._table === "users") {
            // users query has no .where() — returns all users directly
            return Promise.resolve(mockFrom._userResult);
          }
          return {
            where: (...wArgs: unknown[]) => {
              mockWhere(...wArgs);
              return mockFrom._agentResult;
            },
          };
        },
      };
    },
  },
}));

vi.mock("@/db/schema", () => ({
  agents: { _table: "agents", id: "id", name: "name", deletedAt: "deleted_at" },
  usageRecords: { _table: "usage_records" },
  users: { _table: "users", id: "id" },
}));

const mockIsNull = vi.fn((col: unknown) => ({ _type: "isNull", col }));
vi.mock("drizzle-orm", () => ({
  isNull: (col: unknown) => mockIsNull(col),
}));

import {
  parseSessionKey,
  pollAllSessions,
  startUsagePoller,
  stopUsagePoller,
  _isPollerRunning,
} from "@/lib/usage-poller";

function makeOpenClawClient(sessions: unknown[] = []) {
  return {
    sessions: {
      list: vi.fn().mockResolvedValue({ sessions }),
    },
  } as unknown as Parameters<typeof pollAllSessions>[0];
}

describe("parseSessionKey", () => {
  it("parses direct chat session key", () => {
    const result = parseSessionKey("agent:my-agent:direct:user-123");
    expect(result).toEqual({
      agentId: "my-agent",
      userId: "user-123",
      type: "chat",
    });
  });

  it("parses heartbeat/main session key as system", () => {
    const result = parseSessionKey("agent:my-agent:main");
    expect(result).toEqual({
      agentId: "my-agent",
      userId: "system",
      type: "system",
    });
  });

  it("parses cron session key as system", () => {
    const result = parseSessionKey("agent:my-agent:cron:job-1");
    expect(result).toEqual({
      agentId: "my-agent",
      userId: "system",
      type: "system",
    });
  });

  it("preserves userId with colons (e.g. OpenClaw lowercased UUIDs)", () => {
    const result = parseSessionKey("agent:a1:direct:user-123:extra");
    expect(result).toEqual({
      agentId: "a1",
      userId: "user-123:extra",
      type: "chat",
    });
  });

  it("returns null for unparseable keys", () => {
    expect(parseSessionKey("random-string")).toBeNull();
    expect(parseSessionKey("")).toBeNull();
    expect(parseSessionKey("agent:")).toBeNull();
    expect(parseSessionKey("notagent:foo:bar")).toBeNull();
  });
});

describe("pollAllSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
    mockFrom._agentResult = [{ id: "agent-1", name: "Smithers" }];
    mockFrom._userResult = [{ id: "user-1" }, { id: "user-2" }];
  });

  it("filters out soft-deleted agents from the name map", async () => {
    // Soft-deleted agents should not contribute to the poller's agent-name
    // resolution. If a soft-deleted agent's ID happens to match a
    // still-active OpenClaw session (e.g. because deletion is in-flight),
    // we should NOT surface its name via the poller — the DB query must
    // filter on `deleted_at IS NULL`.
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 100, outputTokens: 50 },
    ]);
    await pollAllSessions(client);

    // The poller must have called .where(isNull(agents.deletedAt)).
    expect(mockIsNull).toHaveBeenCalledWith("deleted_at");
  });

  it("handles empty sessions list gracefully", async () => {
    const client = makeOpenClawClient([]);
    await pollAllSessions(client);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("calls recordUsage for each session with tokens", async () => {
    mockFrom._agentResult = [
      { id: "agent-1", name: "Smithers" },
      { id: "agent-2", name: "Burns" },
    ];
    const client = makeOpenClawClient([
      {
        key: "agent:agent-1:direct:user-1",
        inputTokens: 100,
        outputTokens: 50,
        model: "claude",
      },
      {
        key: "agent:agent-2:direct:user-2",
        inputTokens: 200,
        outputTokens: 80,
        model: "claude",
      },
    ]);

    await pollAllSessions(client);

    expect(mockRecordUsage).toHaveBeenCalledTimes(2);
    // The poller MUST pass sessionSnapshot so recordUsage does not issue a
    // second sessions.list() round-trip per session. Check the full shape
    // including the forwarded snapshot fields.
    expect(mockRecordUsage).toHaveBeenCalledWith({
      openclawClient: client,
      userId: "user-1",
      agentId: "agent-1",
      agentName: "Smithers",
      sessionKey: "agent:agent-1:direct:user-1",
      sessionSnapshot: {
        inputTokens: 100,
        outputTokens: 50,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        model: "claude",
      },
    });
    expect(mockRecordUsage).toHaveBeenCalledWith({
      openclawClient: client,
      userId: "user-2",
      agentId: "agent-2",
      agentName: "Burns",
      sessionKey: "agent:agent-2:direct:user-2",
      sessionSnapshot: {
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: undefined,
        cacheWriteTokens: undefined,
        model: "claude",
      },
    });
  });

  it("skips sessions with zero tokens", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 0, outputTokens: 0 },
    ]);
    await pollAllSessions(client);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("skips sessions with unparseable keys", async () => {
    const client = makeOpenClawClient([
      { key: "something-else-entirely", inputTokens: 100, outputTokens: 50 },
    ]);
    await pollAllSessions(client);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("records system sessions with userId='system'", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:main", inputTokens: 100, outputTokens: 50 },
    ]);
    await pollAllSessions(client);
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "system",
        agentId: "agent-1",
        sessionKey: "agent:agent-1:main",
      })
    );
  });

  it("falls back to agentId when agent name is not in DB", async () => {
    mockFrom._agentResult = []; // empty agents table
    const client = makeOpenClawClient([
      { key: "agent:ghost-agent:direct:user-1", inputTokens: 100, outputTokens: 50 },
    ]);
    await pollAllSessions(client);
    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "ghost-agent",
        agentName: "ghost-agent",
      })
    );
  });

  it("does not throw when sessions.list() fails", async () => {
    const client = {
      sessions: {
        list: vi.fn().mockRejectedValue(new Error("OpenClaw unavailable")),
      },
    } as unknown as Parameters<typeof pollAllSessions>[0];

    await expect(pollAllSessions(client)).resolves.toBeUndefined();
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("resolves lowercased userId from session key to original-case DB id", async () => {
    mockFrom._agentResult = [{ id: "agent-1", name: "Smithers" }];
    mockFrom._userResult = [{ id: "zLGhGKUwYqZeQfA4IMwG2oIDSxoYJVqz" }];

    const client = makeOpenClawClient([
      {
        // Session key has lowercase userId (as OpenClaw normalizes)
        key: "agent:agent-1:direct:zlghgkuwyqzeqfa4imwg2oidsxoyjvqz",
        inputTokens: 100,
        outputTokens: 50,
        model: "test-model",
      },
    ]);

    await pollAllSessions(client);

    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        // userId should be the original-case DB id, not the lowercase from the key
        userId: "zLGhGKUwYqZeQfA4IMwG2oIDSxoYJVqz",
      })
    );
  });

  it("does not resolve system userId through user lookup", async () => {
    mockFrom._agentResult = [{ id: "agent-1", name: "Smithers" }];
    mockFrom._userResult = [{ id: "zLGhGKUwYqZeQfA4IMwG2oIDSxoYJVqz" }];

    const client = makeOpenClawClient([
      { key: "agent:agent-1:main", inputTokens: 100, outputTokens: 50 },
    ]);

    await pollAllSessions(client);

    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "system",
      })
    );
  });

  it("does not throw when a single recordUsage call rejects", async () => {
    mockFrom._agentResult = [
      { id: "agent-1", name: "A1" },
      { id: "agent-2", name: "A2" },
    ];
    mockRecordUsage.mockRejectedValueOnce(new Error("db error")).mockResolvedValueOnce(undefined);

    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:u1", inputTokens: 10, outputTokens: 5 },
      { key: "agent:agent-2:direct:u2", inputTokens: 20, outputTokens: 8 },
    ]);

    await expect(pollAllSessions(client)).resolves.toBeUndefined();
    expect(mockRecordUsage).toHaveBeenCalled();
  });
});

describe("startUsagePoller / stopUsagePoller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
    mockFrom._agentResult = [{ id: "agent-1", name: "Smithers" }];
    stopUsagePoller();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopUsagePoller();
    vi.useRealTimers();
  });

  it("is not running before start", () => {
    expect(_isPollerRunning()).toBe(false);
  });

  it("starts polling on startUsagePoller and marks as running", () => {
    const client = makeOpenClawClient([]);
    startUsagePoller(client);
    expect(_isPollerRunning()).toBe(true);
  });

  it("runs an immediate poll on startup before the interval fires", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);

    startUsagePoller(client);

    // The immediate poll is fire-and-forget — flush its microtask
    await vi.advanceTimersByTimeAsync(0);

    // Should have polled once already (immediate), without waiting 60s
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);

    stopUsagePoller();
  });

  it("calls pollAllSessions after each interval tick", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);

    // Immediate poll fires on startup (fire-and-forget)
    await vi.advanceTimersByTimeAsync(0);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);

    // First interval tick at 60s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(2);

    // Second interval tick at 120s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(3);
  });

  it("stops polling on stopUsagePoller", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);
    await vi.advanceTimersByTimeAsync(0); // flush immediate poll
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(2); // immediate + first tick

    stopUsagePoller();
    expect(_isPollerRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(2); // no more calls after stop
  });

  it("is idempotent — multiple starts don't create duplicate intervals", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);
    startUsagePoller(client);
    startUsagePoller(client);

    await vi.advanceTimersByTimeAsync(0); // flush immediate poll
    await vi.advanceTimersByTimeAsync(60_000);
    // Three start calls but only one immediate poll + one tick = 2
    expect(mockRecordUsage).toHaveBeenCalledTimes(2);
  });
});
