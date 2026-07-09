import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { captureChannelMessageSchema } from "@/lib/schemas/channel-messages";

const mockValidateGatewayToken = vi.fn();
vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: (...args: unknown[]) => mockValidateGatewayToken(...args),
}));

const mockOnConflictDoNothing = vi.fn();
const mockValues = vi.fn().mockReturnValue({ onConflictDoNothing: mockOnConflictDoNothing });
const mockInsert = vi.fn().mockReturnValue({ values: mockValues });
const mockFindFirst = vi.fn();
vi.mock("@/db", () => ({
  db: {
    insert: (...args: unknown[]) => mockInsert(...args),
    query: { agents: { findFirst: (...args: unknown[]) => mockFindFirst(...args) } },
  },
}));

// channelMessages/agents are referenced as query targets; sentinels are enough.
vi.mock("@/db/schema", () => ({
  channelMessages: { __table: "channel_messages" },
  agents: { __table: "agents", id: "agents.id" },
}));

const mockMirrorChannelMedia = vi.fn();
vi.mock("@/server/channel-media", () => ({
  mirrorChannelMedia: (...args: unknown[]) => mockMirrorChannelMedia(...args),
}));

const mockAppendAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

const mockRecordAuditFailure = vi.fn();
vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: (...args: unknown[]) => mockRecordAuditFailure(...args),
}));

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
    mockFindFirst.mockResolvedValue({ id: "agent-1", name: "Smithers" });
    mockMirrorChannelMedia.mockResolvedValue([]);
    mockAppendAuditLog.mockResolvedValue(undefined);
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

  describe("media mirroring", () => {
    const mediaBody = {
      ...validBody,
      content: "<media:image>",
      media: [{ path: "/root/.openclaw/media/inbound/photo.jpg", mimeType: "image/jpeg" }],
    };

    it("mirrors media and audits a success", async () => {
      mockFindFirst.mockResolvedValue({ id: "agent-1", name: "Smithers" });
      mockMirrorChannelMedia.mockResolvedValue([
        { filename: "photo.jpg", mimeType: "image/jpeg", bytes: 1024, outcome: "success" },
      ]);

      const res = await POST(makeRequest(mediaBody));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      expect(mockMirrorChannelMedia).toHaveBeenCalledTimes(1);
      expect(mockMirrorChannelMedia).toHaveBeenCalledWith({
        agentId: "agent-1",
        media: mediaBody.media,
      });

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry.eventType).toBe("channel.media_mirrored");
      expect(entry.outcome).toBe("success");
      expect(entry.detail).toMatchObject({
        channel: "telegram",
        agent: { id: "agent-1", name: "Smithers" },
        filename: "photo.jpg",
        mimeType: "image/jpeg",
        bytes: 1024,
      });
    });

    it("audits a failure and still captures the message when the source file is gone (pre-existing conversation / already-cleaned media)", async () => {
      mockFindFirst.mockResolvedValue({ id: "agent-1", name: "Smithers" });
      mockMirrorChannelMedia.mockResolvedValue([
        {
          filename: "photo.jpg",
          mimeType: "image/jpeg",
          bytes: null,
          outcome: "failure",
          error: "ENOENT: no such file",
        },
      ]);

      const res = await POST(makeRequest(mediaBody));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      // The message itself was still captured, independent of the media outcome.
      expect(mockOnConflictDoNothing).toHaveBeenCalledTimes(1);

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry.eventType).toBe("channel.media_mirrored");
      expect(entry.outcome).toBe("failure");
      expect(entry.detail.error).toBe("ENOENT: no such file");
    });

    it("does not mirror or audit when the payload has no media (existing audit-exempt behavior unchanged)", async () => {
      const res = await POST(makeRequest(validBody));
      expect(res.status).toBe(200);
      expect(mockMirrorChannelMedia).not.toHaveBeenCalled();
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
    });

    it("still captures the message and reports via recordAuditFailure when mirrorChannelMedia throws unexpectedly", async () => {
      mockFindFirst.mockResolvedValue({ id: "agent-1", name: "Smithers" });
      mockMirrorChannelMedia.mockRejectedValue(new Error("unexpected boom"));

      const res = await POST(makeRequest(mediaBody));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ success: true });

      expect(mockOnConflictDoNothing).toHaveBeenCalledTimes(1);
      expect(mockAppendAuditLog).not.toHaveBeenCalled();
      expect(mockRecordAuditFailure).toHaveBeenCalledTimes(1);
      const [err] = mockRecordAuditFailure.mock.calls[0];
      expect(err).toBeInstanceOf(Error);
    });

    it("snapshots the agent name from a db lookup, and tolerates a missing agent row", async () => {
      mockFindFirst.mockResolvedValue(undefined);
      mockMirrorChannelMedia.mockResolvedValue([
        { filename: "photo.jpg", mimeType: "image/jpeg", bytes: 1024, outcome: "success" },
      ]);

      const res = await POST(makeRequest(mediaBody));
      expect(res.status).toBe(200);

      expect(mockAppendAuditLog).toHaveBeenCalledTimes(1);
      const entry = mockAppendAuditLog.mock.calls[0][0];
      expect(entry.detail.agent).toEqual({ id: "agent-1", name: null });
    });
  });
});

describe("captureChannelMessageSchema media", () => {
  it("accepts an optional media array", () => {
    const parsed = captureChannelMessageSchema.safeParse({
      ...validBody,
      content: "<media:image>",
      media: [{ path: "/root/.openclaw/media/inbound/file_12---abc.jpg", mimeType: "image/jpeg" }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    // Guards against unknown-key stripping silently making this a false pass.
    expect(parsed.data.media).toBeDefined();
    expect(parsed.data.media).toEqual([
      { path: "/root/.openclaw/media/inbound/file_12---abc.jpg", mimeType: "image/jpeg" },
    ]);
  });

  it("allows a media entry without mimeType", () => {
    const parsed = captureChannelMessageSchema.safeParse({
      ...validBody,
      media: [{ path: "/root/.openclaw/media/inbound/file_12---abc.jpg" }],
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.media).toEqual([
      { path: "/root/.openclaw/media/inbound/file_12---abc.jpg" },
    ]);
  });

  it("rejects a media entry without a path", () => {
    const parsed = captureChannelMessageSchema.safeParse({
      ...validBody,
      media: [{ mimeType: "image/jpeg" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("caps media at 20 entries", () => {
    const media = Array.from({ length: 21 }, (_, i) => ({
      path: `/root/.openclaw/media/inbound/file_${i}.jpg`,
    }));
    const parsed = captureChannelMessageSchema.safeParse({ ...validBody, media });
    expect(parsed.success).toBe(false);
  });

  it("still parses a payload without media (backward compat)", () => {
    const parsed = captureChannelMessageSchema.safeParse(validBody);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.media).toBeUndefined();
  });
});
