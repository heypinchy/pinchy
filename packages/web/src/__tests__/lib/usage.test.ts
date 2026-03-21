import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn();
const mockValues = vi.fn();
const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();

vi.mock("@/db", () => ({
  db: {
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return { values: mockValues };
    },
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return {
        from: (...fArgs: unknown[]) => {
          mockFrom(...fArgs);
          return {
            where: (...wArgs: unknown[]) => {
              mockWhere(...wArgs);
              return mockWhere._result;
            },
          };
        },
      };
    },
  },
}));

vi.mock("@/db/schema", () => ({
  usageRecords: { _table: "usage_records" },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((_col, val) => ({ _type: "eq", val })),
  sum: vi.fn((col) => ({ _type: "sum", col })),
}));

import { recordUsage } from "@/lib/usage";
import { usageRecords } from "@/db/schema";

function makeOpenClawClient(sessions: unknown[] = []) {
  return {
    sessions: {
      list: vi.fn().mockResolvedValue({ sessions }),
    },
  } as unknown as Parameters<typeof recordUsage>[0]["openclawClient"];
}

const baseParams = {
  userId: "user-1",
  agentId: "agent-1",
  agentName: "Smithers",
  sessionKey: "agent:agent-1:user-user-1",
};

describe("recordUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockValues.mockResolvedValue(undefined);
    // Default: no previous records
    mockWhere._result = [
      { totalInput: null, totalOutput: null, totalCacheRead: null, totalCacheWrite: null },
    ];
  });

  it("inserts a usage record when no previous snapshots exist", async () => {
    const client = makeOpenClawClient([
      {
        key: "agent:agent-1:user-user-1",
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 10,
        cacheWriteTokens: 5,
        model: "claude-sonnet-4-20250514",
      },
    ]);

    await recordUsage({ openclawClient: client, ...baseParams });

    expect(mockInsert).toHaveBeenCalledWith(usageRecords);
    expect(mockValues).toHaveBeenCalledWith({
      userId: "user-1",
      agentId: "agent-1",
      agentName: "Smithers",
      sessionKey: "agent:agent-1:user-user-1",
      model: "claude-sonnet-4-20250514",
      inputTokens: 100,
      outputTokens: 200,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      estimatedCostUsd: null,
    });
  });

  it("computes delta correctly when previous snapshots exist", async () => {
    const client = makeOpenClawClient([
      {
        key: "agent:agent-1:user-user-1",
        inputTokens: 500,
        outputTokens: 800,
        cacheReadTokens: 50,
        cacheWriteTokens: 20,
        model: "claude-sonnet-4-20250514",
      },
    ]);

    // Previous records sum
    mockWhere._result = [
      { totalInput: "300", totalOutput: "500", totalCacheRead: "30", totalCacheWrite: "10" },
    ];

    await recordUsage({ openclawClient: client, ...baseParams });

    expect(mockValues).toHaveBeenCalledWith({
      userId: "user-1",
      agentId: "agent-1",
      agentName: "Smithers",
      sessionKey: "agent:agent-1:user-user-1",
      model: "claude-sonnet-4-20250514",
      inputTokens: 200,
      outputTokens: 300,
      cacheReadTokens: 20,
      cacheWriteTokens: 10,
      estimatedCostUsd: null,
    });
  });

  it("skips recording when no token delta", async () => {
    const client = makeOpenClawClient([
      {
        key: "agent:agent-1:user-user-1",
        inputTokens: 100,
        outputTokens: 200,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);

    mockWhere._result = [
      { totalInput: "100", totalOutput: "200", totalCacheRead: "0", totalCacheWrite: "0" },
    ];

    await recordUsage({ openclawClient: client, ...baseParams });

    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("does not throw when sessions.list() fails", async () => {
    const client = {
      sessions: {
        list: vi.fn().mockRejectedValue(new Error("connection failed")),
      },
    } as unknown as Parameters<typeof recordUsage>[0]["openclawClient"];

    await expect(recordUsage({ openclawClient: client, ...baseParams })).resolves.toBeUndefined();
  });

  it("does not throw when session is not found in sessions.list() result", async () => {
    const client = makeOpenClawClient([
      {
        key: "agent:other-agent:user-user-1",
        inputTokens: 100,
        outputTokens: 200,
      },
    ]);

    await expect(recordUsage({ openclawClient: client, ...baseParams })).resolves.toBeUndefined();

    expect(mockInsert).not.toHaveBeenCalled();
  });
});
