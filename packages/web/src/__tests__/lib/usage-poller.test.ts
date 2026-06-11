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
  getPollIntervalMs,
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

  it("maps OpenClaw's cacheRead/cacheWrite session fields into the snapshot", async () => {
    // OpenClaw's session store (verified live on staging, OC 2026.5.28) names
    // the cache counters `cacheRead` / `cacheWrite` — NOT `cacheReadTokens` /
    // `cacheWriteTokens`. Reading the wrong names left every usage_record with
    // cache=0 while Anthropic served ~97% of input from the prompt cache, so
    // the dashboard showed "Input: 7" for a ~400k-token day.
    const client = makeOpenClawClient([
      {
        key: "agent:agent-1:direct:user-1",
        inputTokens: 3,
        outputTokens: 80,
        cacheRead: 14404,
        cacheWrite: 21135,
        model: "claude-sonnet-4-6",
      },
    ]);

    await pollAllSessions(client);

    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSnapshot: expect.objectContaining({
          cacheReadTokens: 14404,
          cacheWriteTokens: 21135,
        }),
      })
    );
  });

  it("still accepts the cacheReadTokens/cacheWriteTokens spelling as fallback", async () => {
    const client = makeOpenClawClient([
      {
        key: "agent:agent-1:direct:user-1",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 111,
        cacheWriteTokens: 222,
        model: "claude-sonnet-4-6",
      },
    ]);

    await pollAllSessions(client);

    expect(mockRecordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionSnapshot: expect.objectContaining({
          cacheReadTokens: 111,
          cacheWriteTokens: 222,
        }),
      })
    );
  });

  it("does not skip a session whose only activity is cache traffic", async () => {
    // Last-turn gauges can show input=0/output=0 while cache counters moved.
    const client = makeOpenClawClient([
      {
        key: "agent:agent-1:direct:user-1",
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 5000,
        cacheWrite: 100,
        model: "claude-sonnet-4-6",
      },
    ]);

    await pollAllSessions(client);

    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
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

describe("getPollIntervalMs", () => {
  const original = process.env.PINCHY_USAGE_POLL_INTERVAL_MS;

  afterEach(() => {
    if (original === undefined) delete process.env.PINCHY_USAGE_POLL_INTERVAL_MS;
    else process.env.PINCHY_USAGE_POLL_INTERVAL_MS = original;
  });

  it("defaults to 60_000ms when the env var is unset", () => {
    delete process.env.PINCHY_USAGE_POLL_INTERVAL_MS;
    expect(getPollIntervalMs()).toBe(60_000);
  });

  it("honors a valid override from PINCHY_USAGE_POLL_INTERVAL_MS", () => {
    process.env.PINCHY_USAGE_POLL_INTERVAL_MS = "2000";
    expect(getPollIntervalMs()).toBe(2000);
  });

  it("clamps sub-second overrides up to the 1_000ms floor", () => {
    // A test stack might try to set this very low; never let the poller
    // hammer OpenClaw faster than once per second.
    process.env.PINCHY_USAGE_POLL_INTERVAL_MS = "10";
    expect(getPollIntervalMs()).toBe(1_000);
  });

  it("falls back to the default for non-numeric or non-positive values", () => {
    // Nonsensical input (garbage, zero, negative) should land on the safe
    // 60s default — NOT get clamped to the 1s floor, which would turn a
    // typo into aggressive once-per-second polling.
    process.env.PINCHY_USAGE_POLL_INTERVAL_MS = "not-a-number";
    expect(getPollIntervalMs()).toBe(60_000);
    process.env.PINCHY_USAGE_POLL_INTERVAL_MS = "0";
    expect(getPollIntervalMs()).toBe(60_000);
    process.env.PINCHY_USAGE_POLL_INTERVAL_MS = "-5000";
    expect(getPollIntervalMs()).toBe(60_000);
  });
});

describe("startUsagePoller honors the configured interval", () => {
  const original = process.env.PINCHY_USAGE_POLL_INTERVAL_MS;

  beforeEach(() => {
    vi.clearAllMocks();
    mockRecordUsage.mockResolvedValue(undefined);
    mockFrom._agentResult = [{ id: "agent-1", name: "Smithers" }];
    mockFrom._userResult = [{ id: "user-1" }];
    stopUsagePoller();
    vi.useFakeTimers();
  });

  afterEach(() => {
    stopUsagePoller();
    vi.useRealTimers();
    if (original === undefined) delete process.env.PINCHY_USAGE_POLL_INTERVAL_MS;
    else process.env.PINCHY_USAGE_POLL_INTERVAL_MS = original;
  });

  it("ticks at the overridden interval rather than the 60s default", async () => {
    process.env.PINCHY_USAGE_POLL_INTERVAL_MS = "2000";
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);

    // No poll before the (short) interval elapses.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(mockRecordUsage).not.toHaveBeenCalled();

    // First tick at 2s, not 60s.
    await vi.advanceTimersByTimeAsync(1);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(2);
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

  it("does NOT poll immediately on startup — first poll fires with the first interval tick", async () => {
    // OC 4.27 introduced a slow sessions.list startup scan (~45s CPU-bound).
    // Calling sessions.list immediately on connect blocks OC's event loop
    // and prevents concurrent agent chat requests from being processed within
    // openclaw-node's request timeout. Removing the immediate poll lets OC
    // finish its internal initialization before the first poll fires at 60s.
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);

    startUsagePoller(client);

    // Flush any microtasks — no poll should have fired yet
    await vi.advanceTimersByTimeAsync(0);

    expect(mockRecordUsage).not.toHaveBeenCalled();

    stopUsagePoller();
  });

  it("calls pollAllSessions after each interval tick", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);

    // First interval tick at 60s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);

    // Second interval tick at 120s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(2);
  });

  it("stops polling on stopUsagePoller", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1); // first tick only

    stopUsagePoller();
    expect(_isPollerRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1); // no more calls after stop
  });

  it("is idempotent — multiple starts don't create duplicate intervals", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);
    startUsagePoller(client);
    startUsagePoller(client);

    await vi.advanceTimersByTimeAsync(60_000);
    // Three start calls but only one interval — one tick = 1
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
  });
});
