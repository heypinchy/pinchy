import { describe, it, expect, vi, beforeEach } from "vitest";

const mockInsert = vi.fn();
const mockValues = vi.fn();

vi.mock("@/db", () => ({
  db: {
    insert: (...args: unknown[]) => {
      mockInsert(...args);
      return { values: mockValues };
    },
  },
}));

const mockGetOrCreateSecret = vi.fn();

vi.mock("@/lib/encryption", () => ({
  getOrCreateSecret: (...args: unknown[]) => mockGetOrCreateSecret(...args),
}));

import { appendAuditLog } from "@/lib/audit";
import { auditLog } from "@/db/schema";

describe("appendAuditLog", () => {
  const fakeSecret = Buffer.from("a".repeat(64), "hex");

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOrCreateSecret.mockReturnValue(fakeSecret);
    mockValues.mockResolvedValue(undefined);
  });

  it("should insert a row into the audit_log table", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "agent.created",
      resource: "agent:abc",
      detail: { name: "Smithers" },
    });

    expect(mockInsert).toHaveBeenCalledWith(auditLog);
    expect(mockValues).toHaveBeenCalledOnce();
  });

  it("should request the audit_hmac_secret", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.login",
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
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.resource).toBeNull();
  });

  it("should default detail to null when not provided", async () => {
    await appendAuditLog({
      actorType: "user",
      actorId: "user-1",
      eventType: "auth.logout",
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
    });

    const insertedRow = mockValues.mock.calls[0][0];
    expect(insertedRow.actorType).toBe("agent");
    expect(insertedRow.actorId).toBe("agent-42");
    expect(insertedRow.eventType).toBe("tool.denied");
    expect(insertedRow.resource).toBe("tool:odoo_read");
    expect(insertedRow.detail).toEqual({ reason: "not allowed" });
  });
});
