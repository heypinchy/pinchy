import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn();
const mockValues = vi.fn();
// Returns the "previous row" the chain reads inside the transaction. Default:
// no prior row (genesis → prevHmac null).
const mockPrevRow = vi.fn();

// appendAuditLog now runs inside db.transaction with an advisory lock and a
// "read the latest row's hmac" select; mock the tx surface it uses.
vi.mock("@/db", () => ({
  db: {
    transaction: async (cb: (tx: unknown) => unknown) => {
      const tx = {
        execute: vi.fn().mockResolvedValue(undefined),
        select: () => ({
          from: () => ({
            orderBy: () => ({
              limit: () => mockPrevRow(),
            }),
          }),
        }),
        insert: (...args: unknown[]) => {
          mockInsert(...args);
          return { values: mockValues };
        },
      };
      return cb(tx);
    },
  },
}));

const mockGetOrCreateSecret = vi.fn();

vi.mock("@/lib/encryption", () => ({
  getOrCreateSecret: (...args: unknown[]) => mockGetOrCreateSecret(...args),
}));

import {
  appendAuditLog,
  computeRowHmacV1,
  computeRowHmacV2,
  computeRowHmacV3,
  type AuditLogEntry,
} from "@/lib/audit";
import { auditLog } from "@/db/schema";

describe("appendAuditLog", () => {
  const fakeSecret = Buffer.from("a".repeat(64), "hex");

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateSecret.mockReturnValue(fakeSecret);
    mockValues.mockResolvedValue(undefined);
    mockPrevRow.mockResolvedValue([]); // genesis: no previous row
  });

  it("should insert a row into the audit_log table", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "Smithers" },
      outcome: "success",
    });

    expect(mockInsert).toHaveBeenCalledWith(auditLog);
    expect(mockValues).toHaveBeenCalledOnce();
  });

  it("should request the audit_hmac_secret", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      outcome: "success",
    });

    expect(mockGetOrCreateSecret).toHaveBeenCalledWith("audit_hmac_secret");
  });

  it("should include a valid HMAC in the inserted row", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "Smithers" },
      outcome: "success",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.rowHmac).toMatch(/^[0-9a-f]{64}$/);
  });

  it("should set a client-side timestamp (not rely on DB default)", async () => {
    const before = new Date();
    await appendAuditLog({
      actorType: "system",
      actorId: "system",
      eventType: "config.changed",
      detail: {},
      outcome: "success",
    });
    const after = new Date();

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.timestamp).toBeInstanceOf(Date);
    expect(insertedRow.timestamp.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(insertedRow.timestamp.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("should default resource to null when not provided", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      outcome: "success",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.resource).toBeNull();
  });

  it("should default detail to null when not provided", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.logout",
      outcome: "success",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.detail).toBeNull();
  });

  it("should truncate large detail objects before inserting", async () => {
    const largeDetail = { data: "x".repeat(3000) };

    await appendAuditLog({
      actorType: "agent",
      actorId: "agent-1",
      eventType: "tool.execute",
      detail: largeDetail,
      outcome: "success",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    const serialized = JSON.stringify(insertedRow.detail);
    expect(serialized.length).toBeLessThanOrEqual(2048);
    expect(insertedRow.detail._truncated).toBe(true);
  });

  it("should pass all fields to the insert", async () => {
    await appendAuditLog({
      actorType: "agent",
      actorId: "agent-42",
      eventType: "tool.denied",
      resource: "tool:odoo_read",
      detail: { reason: "not allowed" },
      outcome: "failure",
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.actorType).toBe("agent");
    expect(insertedRow.actorId).toBe("agent-42");
    expect(insertedRow.eventType).toBe("tool.denied");
    expect(insertedRow.resource).toBe("tool:odoo_read");
    expect(insertedRow.detail).toEqual({ reason: "not allowed" });
  });

  it("should write a v2 row with outcome='success' when outcome is provided", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "tool.web_search",
      resource: "agent:abc",
      detail: { toolName: "web_search" },
      outcome: "success",
    });

    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("success");
    expect(inserted.error).toBeNull();
  });

  it("should write a v2 row with outcome='failure' and error when error is provided", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "tool.web_search",
      resource: "agent:abc",
      detail: { toolName: "web_search" },
      outcome: "failure",
      error: { message: "Brave API key missing" },
    });

    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("failure");
    expect(inserted.error).toEqual({ message: "Brave API key missing" });
  });

  it("type system requires outcome on auth.* events", () => {
    // @ts-expect-error - auth.login must include outcome
    const _bad: AuditLogEntry = {
      actorType: "user",
      actorId: "u1",
      eventType: "auth.login",
      detail: {},
    };
    void _bad;
  });

  it("type system requires outcome on agent.created events", () => {
    // @ts-expect-error - agent.created must include outcome
    const _bad: AuditLogEntry = {
      actorType: "user",
      actorId: "u1",
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "X" },
    };
    void _bad;
  });

  it("writes a v2 row for an auth.login with outcome='success'", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      detail: { email: "a@b.c" },
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("success");
    expect(inserted.error).toBeNull();
  });

  it("writes a v2 row for an auth.failed with outcome='failure' and error", async () => {
    await appendAuditLog({
      actorType: "system",
      actorId: "system",
      eventType: "auth.failed",
      detail: { email: "a@b.c", reason: "invalid_credentials" },
      outcome: "failure",
      error: { message: "Invalid credentials" },
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("failure");
    expect(inserted.error).toEqual({ message: "Invalid credentials" });
  });

  it("writes a v2 row for an agent.created event", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "Smithers" },
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("success");
    expect(inserted.error).toBeNull();
  });

  it("writes a v2 row for a config.changed event", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "config.changed",
      detail: { key: "domain" },
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.version).toBe(3);
    expect(inserted.outcome).toBe("success");
  });

  it("type system requires outcome on tool.* events", () => {
    // @ts-expect-error - tool.* events must include outcome
    const _bad: AuditLogEntry = {
      actorType: "user",
      actorId: "u1",
      eventType: "tool.web_search",
      detail: {},
    };
    void _bad;
  });

  it("hashes v3 rows with computeRowHmacV3 over the stored fields (and not as v1/v2)", async () => {
    // A prior row exists, so this row's prevHmac chains to it.
    mockPrevRow.mockResolvedValueOnce([{ rowHmac: "a".repeat(64) }]);
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "tool.web_search",
      resource: "agent:abc",
      detail: { toolName: "web_search" },
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.rowHmac).toMatch(/^[0-9a-f]{64}$/);
    expect(inserted.version).toBe(3);
    // The chain link is stored.
    expect(inserted.prevHmac).toBe("a".repeat(64));

    // Pin the writer's HMAC inputs to the verifier's: recompute the HMAC over
    // the EXACT fields that were stored (incl. prevHmac). If appendAuditLog ever
    // hashes a different field set the produced hex is still 64 chars and the
    // shape assertion above stays green — but verifyIntegrity recomputes over
    // the stored fields and would flag every newly-written row as tampered. This
    // round-trip catches that drift at write time.
    const fields = {
      timestamp: inserted.timestamp,
      eventType: inserted.eventType,
      actorType: inserted.actorType,
      actorId: inserted.actorId,
      resource: inserted.resource,
      detail: inserted.detail,
      outcome: inserted.outcome,
      error: inserted.error,
      prevHmac: inserted.prevHmac,
    };
    expect(inserted.rowHmac).toBe(computeRowHmacV3(fakeSecret, fields));
    // A v3 row is NOT hashed like v1 or v2 (version literal + chain link differ).
    expect(inserted.rowHmac).not.toBe(computeRowHmacV1(fakeSecret, fields));
    expect(inserted.rowHmac).not.toBe(computeRowHmacV2(fakeSecret, fields));
  });

  it("chains prevHmac to the rowHmac of the most recent existing row", async () => {
    mockPrevRow.mockResolvedValueOnce([{ rowHmac: "b".repeat(64) }]);
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.prevHmac).toBe("b".repeat(64));
  });

  it("writes a null prevHmac for the genesis row (empty table)", async () => {
    // mockPrevRow defaults to [] (no previous row).
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
      outcome: "success",
    });
    const inserted = mockValues.mock.calls[0][0];
    expect(inserted.prevHmac).toBeNull();
  });

  it("accepts attachment.uploaded with the required detail shape", async () => {
    await expect(
      appendAuditLog({
        eventType: "attachment.uploaded",
        actorType: "user",
        actorId: "user-123",
        resource: "agent-1",
        outcome: "success",
        detail: {
          agent: { id: "agent-1", name: "Smithers" },
          uploader: { id: "user-123", name: "Alice Carter" },
          attachment: {
            filename: "invoice.pdf",
            detectedMimeType: "application/pdf",
            sizeBytes: 245_000,
            contentHash: "abc123",
            reused: false,
          },
          sessionKey: "agent:agent-1:direct:user-123",
        },
      })
    ).resolves.toBeUndefined();
  });
});
