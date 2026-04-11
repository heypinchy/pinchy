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
