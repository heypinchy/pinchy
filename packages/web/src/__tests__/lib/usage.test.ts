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

import { recordUsage, _resetPricingCacheForTest } from "@/lib/usage";
import { usageRecords } from "@/db/schema";

const emptyConfig = { config: { models: { providers: {} } } };

function makeOpenClawClient(sessions: unknown[] = [], configResponse: unknown = emptyConfig) {
  return {
    sessions: {
      list: vi.fn().mockResolvedValue({ sessions }),
    },
    config: {
      get: vi.fn().mockResolvedValue(configResponse),
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
    _resetPricingCacheForTest();
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

  it("matches session key case-insensitively (OpenClaw normalizes to lowercase)", async () => {
    const client = makeOpenClawClient([
      {
        key: "agent:agent-1:user-user-1", // lowercase from OpenClaw
        inputTokens: 500,
        outputTokens: 250,
        model: "claude-sonnet-4-20250514",
      },
    ]);

    // Pinchy generates mixed-case session key
    await recordUsage({
      openclawClient: client,
      userId: "user-1",
      agentId: "agent-1",
      agentName: "Smithers",
      sessionKey: "agent:agent-1:user-User-1", // mixed case
    });

    expect(mockInsert).toHaveBeenCalled();
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 500,
        outputTokens: 250,
      })
    );
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

  it("calculates estimated cost from model pricing", async () => {
    const configWithPricing = {
      config: {
        models: {
          providers: {
            anthropic: {
              models: [
                {
                  id: "claude-sonnet-4-20250514",
                  cost: { input: 3.0, output: 15.0 },
                },
              ],
            },
          },
        },
      },
    };

    const client = makeOpenClawClient(
      [
        {
          key: "agent:agent-1:user-user-1",
          inputTokens: 1000,
          outputTokens: 500,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "claude-sonnet-4-20250514",
        },
      ],
      configWithPricing
    );

    await recordUsage({ openclawClient: client, ...baseParams });

    // cost = (1000 * 3.0 / 1_000_000) + (500 * 15.0 / 1_000_000)
    //      = 0.003 + 0.0075 = 0.0105
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        estimatedCostUsd: "0.010500",
      })
    );
  });

  it("sets estimatedCostUsd to null when no pricing configured for model", async () => {
    const configWithOtherModel = {
      config: {
        models: {
          providers: {
            openai: {
              models: [
                {
                  id: "gpt-4o",
                  cost: { input: 5.0, output: 15.0 },
                },
              ],
            },
          },
        },
      },
    };

    const client = makeOpenClawClient(
      [
        {
          key: "agent:agent-1:user-user-1",
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "claude-sonnet-4-20250514",
        },
      ],
      configWithOtherModel
    );

    await recordUsage({ openclawClient: client, ...baseParams });

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        estimatedCostUsd: null,
      })
    );
  });

  it("sets estimatedCostUsd to null when model is null", async () => {
    const configWithPricing = {
      config: {
        models: {
          providers: {
            anthropic: {
              models: [
                {
                  id: "claude-sonnet-4-20250514",
                  cost: { input: 3.0, output: 15.0 },
                },
              ],
            },
          },
        },
      },
    };

    const client = makeOpenClawClient(
      [
        {
          key: "agent:agent-1:user-user-1",
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          // no model field
        },
      ],
      configWithPricing
    );

    await recordUsage({ openclawClient: client, ...baseParams });

    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        estimatedCostUsd: null,
      })
    );
  });

  it("still records usage when config.get() fails", async () => {
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

    // Make config.get() throw (e.g. Gateway unreachable)
    (client.config.get as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("Gateway unreachable")
    );

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

  it("caches config and does not call config.get() again within 5 minutes", async () => {
    const configWithPricing = {
      config: {
        models: {
          providers: {
            anthropic: {
              models: [
                {
                  id: "claude-sonnet-4-20250514",
                  cost: { input: 3.0, output: 15.0 },
                },
              ],
            },
          },
        },
      },
    };

    const client = makeOpenClawClient(
      [
        {
          key: "agent:agent-1:user-user-1",
          inputTokens: 100,
          outputTokens: 200,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "claude-sonnet-4-20250514",
        },
      ],
      configWithPricing
    );

    await recordUsage({ openclawClient: client, ...baseParams });
    // Reset insert mocks but keep config cache
    mockInsert.mockClear();
    mockValues.mockClear();
    mockValues.mockResolvedValue(undefined);
    mockWhere._result = [
      { totalInput: "100", totalOutput: "200", totalCacheRead: "0", totalCacheWrite: "0" },
    ];

    // Update session tokens so a new record is created
    (client.sessions.list as ReturnType<typeof vi.fn>).mockResolvedValue({
      sessions: [
        {
          key: "agent:agent-1:user-user-1",
          inputTokens: 300,
          outputTokens: 400,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          model: "claude-sonnet-4-20250514",
        },
      ],
    });

    await recordUsage({ openclawClient: client, ...baseParams });

    expect(client.config.get).toHaveBeenCalledTimes(1);
  });
});
