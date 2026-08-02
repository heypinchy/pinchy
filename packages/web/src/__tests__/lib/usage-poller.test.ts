// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Real row shapes the mocked `db.select().from(...)` chain resolves to.
type AgentRow = { id: string; name: string };
type UserRow = { id: string };

const mockRecordUsage = vi.fn();
const mockRecordSessionTurns = vi.fn();
const mockSelect = vi.fn();
// `_agentResult`/`_userResult` are real, typed properties on the mock (via
// Object.assign) rather than stashed untyped fields — they let each test
// drive what the mocked `from()`/`where()` chain returns per table without a
// `Mock<Procedure>` type violation.
const mockFrom = Object.assign(vi.fn(), {
  _agentResult: [] as AgentRow[],
  _userResult: [] as UserRow[],
});

vi.mock("@/lib/usage", () => ({
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));

// #483 (chat) / #767 (system): every session is recorded per-turn from the
// trajectory, not the gauge.
vi.mock("@/lib/usage-per-turn", () => ({
  recordSessionTurnsUsage: (...args: unknown[]) => mockRecordSessionTurns(...args),
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
  _resetSessionActivity,
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

  // Chats feature (#508): direct session keys gained a trailing chatId segment
  // (agent:<agentId>:direct:<userId>:<chatId>). The userId segment never
  // contains a colon, so it must be captured WITHOUT swallowing the chatId —
  // otherwise usage is attributed to the bogus user id "<userId>:<chatId>"
  // which never matches the users table.
  it("extracts only the userId from a 5-segment chat session key with a chatId", () => {
    const result = parseSessionKey("agent:a1:direct:user-123:chat-abc");
    expect(result).toEqual({
      agentId: "a1",
      userId: "user-123",
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
    _resetSessionActivity();
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

  it("routes chat sessions to the per-turn trajectory recorder, not the gauge (#483)", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 100, outputTokens: 50, model: "claude" },
    ]);
    await pollAllSessions(client);
    expect(mockRecordUsage).not.toHaveBeenCalled();
    expect(mockRecordSessionTurns).toHaveBeenCalledWith({
      openclawClient: client,
      agentId: "agent-1",
      userId: "user-1",
      agentName: "Smithers",
      sessionKey: "agent:agent-1:direct:user-1",
    });
  });

  it("scans every chat session regardless of the gauge token counts (dedup makes it safe)", async () => {
    // A chat session whose gauge shows 0/0 still gets scanned — the just-
    // completed turn lives in the trajectory even when the gauge was reset.
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 0, outputTokens: 0 },
    ]);
    await pollAllSessions(client);
    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("routes system sessions to the per-turn trajectory recorder too, not the gauge (#767)", async () => {
    // Verified in production: cron/channel sessions DO have a
    // <sessionId>.trajectory.jsonl with promptCache.lastCallUsage, and
    // sessions.json maps every sessionKey (system included) to its
    // sessionId, so resolveSessionId already works for system keys. Routing
    // them through the trajectory recorder gives them context_tokens too —
    // the exact observability gap behind the 2026-07-15 Piper incident.
    const client = makeOpenClawClient([
      { key: "agent:agent-1:cron:job-1", inputTokens: 100, outputTokens: 50, model: "claude" },
    ]);
    await pollAllSessions(client);
    expect(mockRecordUsage).not.toHaveBeenCalled();
    expect(mockRecordSessionTurns).toHaveBeenCalledWith({
      openclawClient: client,
      agentId: "agent-1",
      userId: "system",
      agentName: "Smithers",
      sessionKey: "agent:agent-1:cron:job-1",
    });
  });

  it("routes a channel-style system session to the trajectory recorder too (#767)", async () => {
    // main/cron/hook/channel all parse to type "system" (see parseSessionKey)
    // and must all take the same trajectory path — not just cron.
    const client = makeOpenClawClient([
      { key: "agent:agent-1:telegram:chat-42", inputTokens: 40, outputTokens: 12, model: "claude" },
    ]);
    await pollAllSessions(client);
    expect(mockRecordUsage).not.toHaveBeenCalled();
    expect(mockRecordSessionTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        userId: "system",
        sessionKey: "agent:agent-1:telegram:chat-42",
      })
    );
  });

  it("still resolves OpenClaw's cacheRead/cacheWrite spelling into the change-detection signature (system sessions)", async () => {
    // The #482 cache-field-name fix (cacheRead/cacheWrite, not
    // cacheReadTokens/cacheWriteTokens) used to feed the gauge snapshot; now
    // that system sessions route through the trajectory recorder, it instead
    // feeds gaugeSignature() so a cache-only change still triggers a rescan.
    const first = makeOpenClawClient([
      {
        key: "agent:agent-1:cron:job-1",
        inputTokens: 3,
        outputTokens: 80,
        cacheRead: 0,
        cacheWrite: 0,
        model: "claude-sonnet-4-6",
      },
    ]);
    const second = makeOpenClawClient([
      {
        key: "agent:agent-1:cron:job-1",
        inputTokens: 3,
        outputTokens: 80,
        cacheRead: 14404,
        cacheWrite: 21135,
        model: "claude-sonnet-4-6",
      },
    ]);

    await pollAllSessions(first);
    await pollAllSessions(second);

    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(2);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("still accepts the cacheReadTokens/cacheWriteTokens spelling as a fallback in the change-detection signature", async () => {
    const first = makeOpenClawClient([
      {
        key: "agent:agent-1:cron:job-1",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        model: "claude-sonnet-4-6",
      },
    ]);
    const second = makeOpenClawClient([
      {
        key: "agent:agent-1:cron:job-1",
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 111,
        cacheWriteTokens: 222,
        model: "claude-sonnet-4-6",
      },
    ]);

    await pollAllSessions(first);
    await pollAllSessions(second);

    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(2);
  });

  it("scans a system session whose only activity is cache traffic, same as a chat session (#767)", async () => {
    // Last-turn gauges can show input=0/output=0 while cache counters moved.
    // System sessions are scanned exactly like chat sessions now — the
    // trajectory recorder (not a gauge hasTokens gate) decides whether
    // there's anything to record.
    const client = makeOpenClawClient([
      {
        key: "agent:agent-1:cron:job-1",
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 5000,
        cacheWrite: 100,
        model: "claude-sonnet-4-6",
      },
    ]);

    await pollAllSessions(client);

    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("scans a system session with zero gauge tokens via the trajectory recorder — the trajectory decides, not the gauge (#767)", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:main", inputTokens: 0, outputTokens: 0 },
    ]);
    await pollAllSessions(client);
    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(1);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("skips sessions with unparseable keys", async () => {
    const client = makeOpenClawClient([
      { key: "something-else-entirely", inputTokens: 100, outputTokens: 50 },
    ]);
    await pollAllSessions(client);
    expect(mockRecordUsage).not.toHaveBeenCalled();
    expect(mockRecordSessionTurns).not.toHaveBeenCalled();
  });

  it("routes system sessions to the trajectory recorder with userId='system'", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:main", inputTokens: 100, outputTokens: 50 },
    ]);
    await pollAllSessions(client);
    expect(mockRecordSessionTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "system",
        agentId: "agent-1",
        sessionKey: "agent:agent-1:main",
      })
    );
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("falls back to agentId when agent name is not in DB (path-agnostic)", async () => {
    mockFrom._agentResult = []; // empty agents table
    const client = makeOpenClawClient([
      { key: "agent:ghost-agent:direct:user-1", inputTokens: 100, outputTokens: 50 },
    ]);
    await pollAllSessions(client);
    // Chat session → per-turn recorder; the agentName fallback is computed
    // before the chat/system branch, so it applies on either path.
    expect(mockRecordSessionTurns).toHaveBeenCalledWith(
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

    // Chat session → per-turn recorder, which receives the resolved userId.
    expect(mockRecordSessionTurns).toHaveBeenCalledWith(
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

    expect(mockRecordSessionTurns).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: "system",
      })
    );
  });

  it("does not throw when a single system-session recordSessionTurns call rejects", async () => {
    mockFrom._agentResult = [
      { id: "agent-1", name: "A1" },
      { id: "agent-2", name: "A2" },
    ];
    mockRecordSessionTurns
      .mockRejectedValueOnce(new Error("trajectory read error"))
      .mockResolvedValueOnce(0);

    // System sessions now use the per-turn trajectory recorder; a rejecting
    // call must not abort the whole poll.
    const client = makeOpenClawClient([
      { key: "agent:agent-1:cron:j1", inputTokens: 10, outputTokens: 5 },
      { key: "agent:agent-2:cron:j2", inputTokens: 20, outputTokens: 8 },
    ]);

    await expect(pollAllSessions(client)).resolves.toBeUndefined();
    expect(mockRecordSessionTurns).toHaveBeenCalled();
  });
});

describe("pollAllSessions adaptive backoff (#261)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSessionActivity();
    mockRecordSessionTurns.mockResolvedValue(undefined);
    mockRecordUsage.mockResolvedValue(undefined);
    mockFrom._agentResult = [{ id: "agent-1", name: "Smithers" }];
    mockFrom._userResult = [{ id: "user-1" }];
  });

  it("skips the per-turn scan for a chat session whose gauge is unchanged since the last poll", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 100, outputTokens: 50 },
    ]);

    await pollAllSessions(client);
    await pollAllSessions(client); // identical gauge → idle → skip the scan

    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(1);
  });

  it("skips the per-turn scan for a system session whose gauge is unchanged since the last poll", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:cron:job-1", inputTokens: 100, outputTokens: 50 },
    ]);

    await pollAllSessions(client);
    await pollAllSessions(client); // identical gauge → idle → skip

    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(1);
  });

  it("re-processes when the gauge changes (a new turn happened)", async () => {
    const first = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 100, outputTokens: 50 },
    ]);
    const second = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 140, outputTokens: 70 },
    ]);

    await pollAllSessions(first);
    await pollAllSessions(second); // gauge grew → active → scan again

    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(2);
  });

  it("re-processes when a cache counter changes even if input/output are static", async () => {
    const first = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 100, outputTokens: 50, cacheRead: 0 },
    ]);
    const second = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 100, outputTokens: 50, cacheRead: 900 },
    ]);

    await pollAllSessions(first);
    await pollAllSessions(second);

    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(2);
  });

  it("does a periodic catch-up scan for an idle session after IDLE_RESCAN_MS", async () => {
    vi.useFakeTimers();
    try {
      const client = makeOpenClawClient([
        { key: "agent:agent-1:direct:user-1", inputTokens: 100, outputTokens: 50 },
      ]);

      await pollAllSessions(client);
      // Still idle (unchanged gauge) but past the catch-up window.
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await pollAllSessions(client);

      expect(mockRecordSessionTurns).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("processes each session independently — one active session does not un-idle another", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 100, outputTokens: 50 },
      { key: "agent:agent-1:direct:user-2", inputTokens: 200, outputTokens: 80 },
    ]);
    mockFrom._userResult = [{ id: "user-1" }, { id: "user-2" }];

    await pollAllSessions(client);
    // user-1 grows, user-2 stays idle.
    const next = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 130, outputTokens: 60 },
      { key: "agent:agent-1:direct:user-2", inputTokens: 200, outputTokens: 80 },
    ]);
    await pollAllSessions(next);

    // 2 (first poll, both) + 1 (second poll, only user-1) = 3 scans.
    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(3);
  });

  // Review finding: the fingerprint must NOT be recorded until the record call
  // actually succeeds. Recording it eagerly (before the await) means a
  // transient recordUsage/recordSessionTurns failure still "poisons" the
  // session as processed — the next tick sees an unchanged gauge and skips it
  // for up to IDLE_RESCAN_MS (5 min), even though the record never happened.
  // Pre-adaptive-backoff behavior retried every tick (60s); this restores
  // that retry behavior for failed record calls specifically.
  it("retries a system session every tick after a transient recordSessionTurns failure, instead of treating it as processed", async () => {
    mockRecordSessionTurns.mockRejectedValueOnce(new Error("db blip"));
    const client = makeOpenClawClient([
      { key: "agent:agent-1:cron:job-1", inputTokens: 100, outputTokens: 50 },
    ]);

    await pollAllSessions(client); // fails — must not mark the session as processed
    await pollAllSessions(client); // identical gauge — should still retry, not skip

    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(2);
  });

  it("retries a chat session every tick after a transient recordSessionTurns failure, instead of treating it as processed", async () => {
    mockRecordSessionTurns.mockRejectedValueOnce(new Error("db blip"));
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 100, outputTokens: 50 },
    ]);

    await pollAllSessions(client); // fails — must not mark the session as processed
    await pollAllSessions(client); // identical gauge — should still retry, not skip

    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(2);
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
    _resetSessionActivity();
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

    // sessions.list() fires once per tick regardless of adaptive backoff (which
    // only skips per-session recording), so it's the direct signal that the
    // interval fired — recordSessionTurns would be masked by the idle skip.
    // No poll before the (short) interval elapses.
    await vi.advanceTimersByTimeAsync(1_999);
    expect(client.sessions.list).not.toHaveBeenCalled();

    // First tick at 2s, not 60s.
    await vi.advanceTimersByTimeAsync(1);
    expect(client.sessions.list).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2_000);
    expect(client.sessions.list).toHaveBeenCalledTimes(2);
  });
});

describe("startUsagePoller / stopUsagePoller", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    _resetSessionActivity();
    mockRecordSessionTurns.mockResolvedValue(undefined);
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

    expect(mockRecordSessionTurns).not.toHaveBeenCalled();

    stopUsagePoller();
  });

  it("calls pollAllSessions after each interval tick", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);

    // Assert on sessions.list() (one call per pollAllSessions) rather than
    // recordSessionTurns: adaptive backoff (#261) deliberately skips the scan
    // for an idle session on the second tick, but the poll itself still runs.
    // First interval tick at 60s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.sessions.list).toHaveBeenCalledTimes(1);

    // Second interval tick at 120s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(client.sessions.list).toHaveBeenCalledTimes(2);
  });

  it("stops polling on stopUsagePoller", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(1); // first tick only

    stopUsagePoller();
    expect(_isPollerRunning()).toBe(false);

    await vi.advanceTimersByTimeAsync(120_000);
    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(1); // no more calls after stop
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
    expect(mockRecordSessionTurns).toHaveBeenCalledTimes(1);
  });
});
