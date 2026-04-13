import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mockInsert = vi.fn();
const mockValues = vi.fn();

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/db", () => ({
  db: {
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return { values: mockValues };
    },
  },
}));

vi.mock("@/db/schema", () => ({
  usageRecords: { _table: "usage_records" },
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
import { usageRecords } from "@/db/schema";
import { POST } from "@/app/api/internal/usage/record/route";
import { resetUsageRecordRateLimiterForTest } from "@/lib/usage-record-rate-limiter";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/internal/usage/record", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer gw-token",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/usage/record", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
    mockValues.mockResolvedValue(undefined);
    resetUsageRecordRateLimiterForTest();
  });

  it("returns 401 when gateway token is invalid", async () => {
    vi.mocked(validateGatewayToken).mockReturnValue(false);

    const res = await POST(
      makeRequest({
        agentId: "agent-1",
        agentName: "Smithers",
        userId: "system",
        sessionKey: "plugin:pinchy-files",
        model: "anthropic/claude-haiku-4-5-20251001",
        inputTokens: 100,
        outputTokens: 20,
      })
    );

    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when required fields are missing", async () => {
    const res = await POST(
      makeRequest({
        // agentId missing
        agentName: "Smithers",
        userId: "system",
        sessionKey: "plugin:pinchy-files",
        inputTokens: 100,
        outputTokens: 20,
      })
    );

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 when token counts are not numbers", async () => {
    const res = await POST(
      makeRequest({
        agentId: "agent-1",
        agentName: "Smithers",
        userId: "system",
        sessionKey: "plugin:pinchy-files",
        inputTokens: "not-a-number",
        outputTokens: 20,
      })
    );

    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("inserts a usage record on a valid request", async () => {
    const res = await POST(
      makeRequest({
        agentId: "agent-1",
        agentName: "Smithers",
        userId: "system",
        sessionKey: "plugin:pinchy-files",
        model: "anthropic/claude-haiku-4-5-20251001",
        inputTokens: 123,
        outputTokens: 45,
      })
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ success: true });

    expect(mockInsert).toHaveBeenCalledWith(usageRecords);
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        agentId: "agent-1",
        agentName: "Smithers",
        userId: "system",
        sessionKey: "plugin:pinchy-files",
        model: "anthropic/claude-haiku-4-5-20251001",
        inputTokens: 123,
        outputTokens: 45,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      })
    );
  });

  it("rejects with 429 once the per-minute rate limit is exceeded", async () => {
    // Defense-in-depth: even behind a gateway token, the endpoint should
    // refuse to accept unbounded writes. A runaway plugin or a leaked token
    // must not be able to flood usage_records at line-rate. The limit is
    // generous enough for legitimate plugin traffic (many PDF vision calls
    // at once), but still bounded.
    const RATE_LIMIT_MAX = 300;

    // Send RATE_LIMIT_MAX successful requests first
    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await POST(
        makeRequest({
          agentId: "agent-1",
          agentName: "Smithers",
          userId: "system",
          sessionKey: "plugin:pinchy-files",
          inputTokens: 1,
          outputTokens: 1,
        })
      );
      expect(res.status).toBe(200);
    }

    // The next one must be rejected
    const res = await POST(
      makeRequest({
        agentId: "agent-1",
        agentName: "Smithers",
        userId: "system",
        sessionKey: "plugin:pinchy-files",
        inputTokens: 1,
        outputTokens: 1,
      })
    );

    expect(res.status).toBe(429);
    // Rate-limited requests must NOT hit the DB
    expect(mockInsert).toHaveBeenCalledTimes(RATE_LIMIT_MAX);
  });

  it("allows requests again after the rate-limit window expires", async () => {
    // Drive time forward via a fake clock so the test doesn't block on real
    // time. Reset the limiter, burn through the limit, advance past the
    // window, then confirm we can write again.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-11T12:00:00Z"));

    try {
      resetUsageRecordRateLimiterForTest();
      const RATE_LIMIT_MAX = 300;

      for (let i = 0; i < RATE_LIMIT_MAX; i++) {
        await POST(
          makeRequest({
            agentId: "agent-1",
            agentName: "Smithers",
            userId: "system",
            sessionKey: "plugin:pinchy-files",
            inputTokens: 1,
            outputTokens: 1,
          })
        );
      }

      // At the limit — this call is blocked
      const blocked = await POST(
        makeRequest({
          agentId: "agent-1",
          agentName: "Smithers",
          userId: "system",
          sessionKey: "plugin:pinchy-files",
          inputTokens: 1,
          outputTokens: 1,
        })
      );
      expect(blocked.status).toBe(429);

      // Advance past the 1-minute window
      vi.setSystemTime(new Date("2026-04-11T12:01:01Z"));

      const allowed = await POST(
        makeRequest({
          agentId: "agent-1",
          agentName: "Smithers",
          userId: "system",
          sessionKey: "plugin:pinchy-files",
          inputTokens: 1,
          outputTokens: 1,
        })
      );
      expect(allowed.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("counts unauthorized (401) requests toward the rate limit to block brute-force token guessing", async () => {
    // Without this, an attacker could guess gateway tokens at line rate.
    // The rate limit must apply BEFORE the token check.
    vi.mocked(validateGatewayToken).mockReturnValue(false);
    const RATE_LIMIT_MAX = 300;

    for (let i = 0; i < RATE_LIMIT_MAX; i++) {
      const res = await POST(
        makeRequest({
          agentId: "agent-1",
          agentName: "Smithers",
          userId: "system",
          sessionKey: "plugin:pinchy-files",
          inputTokens: 1,
          outputTokens: 1,
        })
      );
      expect(res.status).toBe(401);
    }

    const res = await POST(
      makeRequest({
        agentId: "agent-1",
        agentName: "Smithers",
        userId: "system",
        sessionKey: "plugin:pinchy-files",
        inputTokens: 1,
        outputTokens: 1,
      })
    );
    expect(res.status).toBe(429);
  });

  it("allows model to be omitted", async () => {
    const res = await POST(
      makeRequest({
        agentId: "agent-1",
        agentName: "Smithers",
        userId: "system",
        sessionKey: "plugin:pinchy-files",
        inputTokens: 10,
        outputTokens: 5,
      })
    );

    expect(res.status).toBe(200);
    expect(mockValues).toHaveBeenCalledWith(
      expect.objectContaining({
        model: null,
      })
    );
  });
});
