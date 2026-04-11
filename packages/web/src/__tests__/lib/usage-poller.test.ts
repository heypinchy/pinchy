import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockRecordUsage = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();

vi.mock("@/lib/usage", () => ({
  recordUsage: (...args: unknown[]) => mockRecordUsage(...args),
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return {
        from: (...fArgs: unknown[]) => {
          mockFrom(...fArgs);
          return mockFrom._result;
        },
      };
    },
  },
}));

vi.mock("@/db/schema", () => ({
  agents: { _table: "agents", id: "id", name: "name" },
  usageRecords: { _table: "usage_records" },
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
    mockFrom._result = [{ id: "agent-1", name: "Smithers" }];
  });

  it("handles empty sessions list gracefully", async () => {
    const client = makeOpenClawClient([]);
    await pollAllSessions(client);
    expect(mockRecordUsage).not.toHaveBeenCalled();
  });

  it("calls recordUsage for each session with tokens", async () => {
    mockFrom._result = [
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
    expect(mockRecordUsage).toHaveBeenCalledWith({
      openclawClient: client,
      userId: "user-1",
      agentId: "agent-1",
      agentName: "Smithers",
      sessionKey: "agent:agent-1:direct:user-1",
    });
    expect(mockRecordUsage).toHaveBeenCalledWith({
      openclawClient: client,
      userId: "user-2",
      agentId: "agent-2",
      agentName: "Burns",
      sessionKey: "agent:agent-2:direct:user-2",
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
    mockFrom._result = []; // empty agents table
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

  it("does not throw when a single recordUsage call rejects", async () => {
    mockFrom._result = [
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
    mockFrom._result = [{ id: "agent-1", name: "Smithers" }];
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

  it("calls pollAllSessions after each interval tick", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);

    expect(mockRecordUsage).not.toHaveBeenCalled();

    // First tick at 60s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);

    // Second tick at 120s
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(2);
  });

  it("stops polling on stopUsagePoller", async () => {
    const client = makeOpenClawClient([
      { key: "agent:agent-1:direct:user-1", inputTokens: 10, outputTokens: 5 },
    ]);
    startUsagePoller(client);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);

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
    // Three start calls, one tick → still only one recordUsage call
    expect(mockRecordUsage).toHaveBeenCalledTimes(1);
  });
});
