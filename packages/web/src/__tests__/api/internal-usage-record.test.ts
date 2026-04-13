import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

vi.mock("@/lib/usage-record-rate-limiter", () => ({
  tryAcquireUsageRecordSlot: vi.fn().mockReturnValue(true),
}));

vi.mock("@/db", () => ({
  db: {
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockResolvedValue(undefined),
    }),
  },
}));

vi.mock("@/db/schema", () => ({
  usageRecords: "usageRecords",
}));

import { validateGatewayToken } from "@/lib/gateway-auth";
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

const validPayload = {
  agentId: "a1",
  agentName: "Bot",
  userId: "u1",
  sessionKey: "plugin:test",
  inputTokens: 100,
  outputTokens: 50,
};

describe("POST /api/internal/usage/record", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(validateGatewayToken).mockReturnValue(true);
  });

  it("accepts valid payload", async () => {
    const res = await POST(makeRequest(validPayload));
    expect(res.status).toBe(200);
  });

  it("rejects negative inputTokens", async () => {
    const res = await POST(makeRequest({ ...validPayload, inputTokens: -100 }));
    expect(res.status).toBe(400);
  });

  it("rejects negative outputTokens", async () => {
    const res = await POST(makeRequest({ ...validPayload, outputTokens: -50 }));
    expect(res.status).toBe(400);
  });
});
