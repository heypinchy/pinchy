import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockValidateGatewayToken = vi.fn();
vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: (...args: unknown[]) => mockValidateGatewayToken(...args),
}));

const mockOnConflictDoNothing = vi.fn();
const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
vi.mock("@/db", () => ({
  db: { insert: (...args: unknown[]) => mockInsert(...args) },
}));

// channelMessages is referenced as the insert target; a sentinel is enough.
vi.mock("@/db/schema", () => ({ channelMessages: { __table: "channel_messages" } }));

function makeRequest(body: unknown) {
  return new NextRequest("http://localhost/api/internal/channel-messages", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer tok" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  channel: "telegram",
  // agentId + peer are derived from this; the body carries no peerId.
  sessionKey: "agent:agent-1:direct:TG-Peer-111",
  direction: "inbound",
  externalId: "msg-42",
  content: "Hello over Telegram",
  sentAt: 1700000000000,
};

describe("POST /api/internal/channel-messages", () => {
  let POST: typeof import("@/app/api/internal/channel-messages/route").POST;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockValidateGatewayToken.mockReturnValue(true);
    mockOnConflictDoNothing.mockResolvedValue(undefined);
    POST = (await import("@/app/api/internal/channel-messages/route")).POST;
  });

  it("returns 401 when the gateway token is invalid", async () => {
    mockValidateGatewayToken.mockReturnValueOnce(false);
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(401);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 on an invalid body", async () => {
    const res = await POST(makeRequest({ ...validBody, direction: "sideways" }));
    expect(res.status).toBe(400);
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("returns 400 for a non-direct or malformed sessionKey", async () => {
    for (const sessionKey of ["not-a-session", "agent:agent-1:group:g", "agent:agent-1:direct:"]) {
      const res = await POST(makeRequest({ ...validBody, sessionKey }));
      expect(res.status, sessionKey).toBe(400);
    }
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("derives BOTH agentId and peer from sessionKey, lowercases the peer, and upserts idempotently", async () => {
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(200);

    expect(mockValues).toHaveBeenCalledTimes(1);
    const values = mockValues.mock.calls[0][0];
    expect(values).toMatchObject({
      agentId: "agent-1", // derived from sessionKey, NOT trusted from body
      channel: "telegram",
      peerId: "tg-peer-111", // ALSO derived from sessionKey (no body peerId), lowercased
      direction: "inbound",
      externalId: "msg-42",
      content: "Hello over Telegram",
    });
    expect(values.sentAt).toBeInstanceOf(Date);
    expect((values.sentAt as Date).getTime()).toBe(1700000000000);

    // Idempotent capture: retries / duplicate hook fires must not double-insert.
    expect(mockOnConflictDoNothing).toHaveBeenCalledTimes(1);
  });

  it("returns 503 (retryable) when the DB write fails", async () => {
    mockOnConflictDoNothing.mockRejectedValueOnce(new Error("db down"));
    const res = await POST(makeRequest(validBody));
    expect(res.status).toBe(503);
  });
});
