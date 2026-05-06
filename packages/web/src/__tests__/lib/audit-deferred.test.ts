import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mockAppendAuditLog = vi.fn();
vi.mock("@/lib/audit", () => ({
  appendAuditLog: (...args: unknown[]) => mockAppendAuditLog(...args),
}));

import {
  deferAuditLog,
  recordAuditFailure,
  getAuditWriteFailedCount,
  resetAuditWriteFailedCount,
} from "@/lib/audit-deferred";

const validEntry = {
  actorType: "user" as const,
  actorId: "user-1",
  eventType: "config.changed" as const,
  resource: "integration:abc",
  detail: { action: "integration_created", type: "odoo", name: "Test" },
  outcome: "success" as const,
};

describe("deferAuditLog", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    mockAppendAuditLog.mockReset();
    resetAuditWriteFailedCount();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("invokes appendAuditLog with the entry", async () => {
    mockAppendAuditLog.mockResolvedValue(undefined);
    deferAuditLog(validEntry);
    // The test-setup `after()` mock runs callbacks synchronously, but the
    // inner appendAuditLog is async — flush microtasks.
    await new Promise((r) => setImmediate(r));
    expect(mockAppendAuditLog).toHaveBeenCalledWith(validEntry);
  });

  it("does not increment failure counter on success", async () => {
    mockAppendAuditLog.mockResolvedValue(undefined);
    deferAuditLog(validEntry);
    await new Promise((r) => setImmediate(r));
    expect(getAuditWriteFailedCount()).toBe(0);
  });

  it("increments failure counter when appendAuditLog rejects", async () => {
    mockAppendAuditLog.mockRejectedValue(new Error("DB unreachable"));
    deferAuditLog(validEntry);
    await new Promise((r) => setImmediate(r));
    expect(getAuditWriteFailedCount()).toBe(1);
  });

  it("emits a structured JSON log line on failure (not a plain console.error message)", async () => {
    mockAppendAuditLog.mockRejectedValue(new Error("DB unreachable"));
    deferAuditLog(validEntry);
    await new Promise((r) => setImmediate(r));

    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const arg = consoleErrorSpy.mock.calls[0][0];
    expect(typeof arg).toBe("string");
    const parsed = JSON.parse(arg as string);
    expect(parsed).toMatchObject({
      level: "error",
      event: "audit_log_write_failed",
      eventType: "config.changed",
      actorId: "user-1",
      resource: "integration:abc",
      outcome: "success",
      error: { message: "DB unreachable" },
    });
  });

  it("does not throw when appendAuditLog rejects (failure stays inside after())", async () => {
    mockAppendAuditLog.mockRejectedValue(new Error("DB unreachable"));
    expect(() => deferAuditLog(validEntry)).not.toThrow();
    await new Promise((r) => setImmediate(r));
  });

  it("counts multiple failures cumulatively", async () => {
    mockAppendAuditLog.mockRejectedValue(new Error("boom"));
    deferAuditLog(validEntry);
    deferAuditLog(validEntry);
    deferAuditLog(validEntry);
    await new Promise((r) => setImmediate(r));
    expect(getAuditWriteFailedCount()).toBe(3);
  });

  it("resetAuditWriteFailedCount clears the counter", async () => {
    mockAppendAuditLog.mockRejectedValue(new Error("boom"));
    deferAuditLog(validEntry);
    await new Promise((r) => setImmediate(r));
    expect(getAuditWriteFailedCount()).toBe(1);
    resetAuditWriteFailedCount();
    expect(getAuditWriteFailedCount()).toBe(0);
  });
});

describe("recordAuditFailure", () => {
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    resetAuditWriteFailedCount();
    consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  it("increments the failure counter", () => {
    recordAuditFailure(new Error("boom"), validEntry);
    expect(getAuditWriteFailedCount()).toBe(1);
  });

  it("emits a structured JSON log line", () => {
    recordAuditFailure(new Error("DB unreachable"), validEntry);
    expect(consoleErrorSpy).toHaveBeenCalledTimes(1);
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(parsed).toMatchObject({
      level: "error",
      event: "audit_log_write_failed",
      eventType: "config.changed",
      actorType: "user",
      actorId: "user-1",
      resource: "integration:abc",
      outcome: "success",
      error: { message: "DB unreachable" },
    });
  });

  it("stringifies non-Error throws", () => {
    recordAuditFailure("string error", validEntry);
    const parsed = JSON.parse(consoleErrorSpy.mock.calls[0][0] as string);
    expect(parsed.error.message).toBe("string error");
  });

  it("does not throw", () => {
    expect(() => recordAuditFailure(new Error("boom"), validEntry)).not.toThrow();
  });
});
