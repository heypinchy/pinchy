/**
 * Unit tests for the periodic incremental audit-chain verification job
 * (audit-verify-job.ts). verifyIntegrity and the checkpoint store are mocked
 * here — the real-DB proof that the boundary-seed actually closes the attack
 * window lives in audit-verify-job.integration.test.ts.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const {
  mockVerifyIntegrity,
  mockAppendAuditLog,
  mockRecordAuditFailure,
  mockCheckpointWhere,
  mockAuditLogWhere,
  mockOwnRowLimit,
  mockInsertValues,
  mockOnConflictDoUpdate,
  mockInsert,
  mockSelect,
} = vi.hoisted(() => {
  const mockVerifyIntegrity = vi.fn();
  const mockAppendAuditLog = vi.fn().mockResolvedValue(undefined);
  const mockRecordAuditFailure = vi.fn();

  // db.select(...).from(auditVerifyState).where(...) -> checkpoint row(s)
  const mockCheckpointWhere = vi.fn();
  // db.select(...).from(auditLog).where(...) -> last-scanned row's hmac
  const mockAuditLogWhere = vi.fn();
  // db.select(...).from(auditLog).orderBy(desc(...)).limit(1) -> the sweep's
  // own just-appended audit.integrity_check row (self-fold into checkpoint)
  const mockOwnRowLimit = vi.fn();
  const mockOwnRowOrderBy = vi.fn().mockReturnValue({ limit: mockOwnRowLimit });

  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockInsertValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  // A single db.select() stub serves both tables the module queries,
  // routing on which table object .from(...) is called with (identity
  // comparison against the __marker tag the @/db/schema mock below attaches).
  const mockSelect = vi.fn(() => ({
    from: (table: unknown) => {
      const isCheckpointTable =
        typeof table === "object" &&
        table !== null &&
        (table as { __marker?: string }).__marker === "auditVerifyState";
      if (isCheckpointTable) return { where: mockCheckpointWhere };
      return { where: mockAuditLogWhere, orderBy: mockOwnRowOrderBy };
    },
  }));

  return {
    mockVerifyIntegrity,
    mockAppendAuditLog,
    mockRecordAuditFailure,
    mockCheckpointWhere,
    mockAuditLogWhere,
    mockOwnRowLimit,
    mockInsertValues,
    mockOnConflictDoUpdate,
    mockInsert,
    mockSelect,
  };
});

vi.mock("@/lib/audit", () => ({
  verifyIntegrity: mockVerifyIntegrity,
  appendAuditLog: mockAppendAuditLog,
}));

vi.mock("@/lib/audit-deferred", () => ({
  recordAuditFailure: mockRecordAuditFailure,
}));

vi.mock("@/db/schema", () => ({
  auditVerifyState: { __marker: "auditVerifyState", id: "id-col" },
  auditLog: { __marker: "auditLog", id: "audit-id-col", rowHmac: "row-hmac-col" },
}));

vi.mock("@/db", () => ({
  db: {
    select: (...args: unknown[]) => mockSelect(...args),
    insert: (...args: unknown[]) => mockInsert(...args),
  },
}));

import {
  sweepAuditVerify,
  startAuditVerifyJob,
  stopAuditVerifyJob,
  _isAuditVerifyJobRunning,
  getAuditIntegrityViolationCount,
  resetAuditIntegrityViolationCount,
} from "@/server/audit-verify-job";

function mockCheckpointRow(
  row: { lastVerifiedId: number; lastVerifiedHmac: string | null } | null
) {
  mockCheckpointWhere.mockResolvedValue(row ? [row] : []);
}

function mockLastScannedRow(rowHmac: string | null) {
  mockAuditLogWhere.mockResolvedValue(rowHmac !== null ? [{ rowHmac }] : []);
}

// The row the sweep's OWN appendAuditLog call just inserted — the module
// re-reads MAX(id) to fold that row into the checkpoint too (see
// audit-verify-job.ts's "self-fold" comment), so the checkpoint always
// converges to a true no-op on the next call instead of perpetually
// rediscovering its own prior report.
function mockOwnReportRow(id: number, rowHmac: string) {
  mockOwnRowLimit.mockResolvedValue([{ id, rowHmac }]);
}

describe("sweepAuditVerify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditIntegrityViolationCount();
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
    mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
    mockInsert.mockReturnValue({ values: mockInsertValues });
  });

  it("no new rows since the checkpoint: no-op, no audit row, checkpoint untouched", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "abc" });
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 0,
      invalidIds: [],
      chainBreakIds: [],
    });

    const result = await sweepAuditVerify();

    expect(result.scanned).toBe(false);
    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, undefined, { seedPrevHmac: "abc" });
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("defaults to lastVerifiedId=0 / seedPrevHmac=null when no checkpoint row exists yet", async () => {
    mockCheckpointRow(null);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 0,
      invalidIds: [],
      chainBreakIds: [],
    });

    await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(1, undefined, { seedPrevHmac: null });
  });

  it("clean run: advances the checkpoint past its own report row and emits audit.integrity_check success", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 3, // rows 11, 12, 13
      invalidIds: [],
      chainBreakIds: [],
    });
    mockLastScannedRow("hmac-13");
    // The sweep's own appendAuditLog call inserts row 14; the module re-reads
    // MAX(id) and folds it into the checkpoint too.
    mockOwnReportRow(14, "hmac-14");

    const result = await sweepAuditVerify();

    expect(result).toEqual({
      scanned: true,
      scannedFrom: 11,
      scannedTo: 13,
      valid: true,
      invalidCount: 0,
      chainBreakCount: 0,
    });

    // Checkpoint advances to row 14 (its own report), not just to row 13 (the
    // last row actually verified this run) — otherwise the next sweep would
    // perpetually rediscover exactly this run's own audit.integrity_check row.
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 1,
        lastVerifiedId: 14,
        lastVerifiedHmac: "hmac-14",
        lastStatus: "ok",
      })
    );
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({
          lastVerifiedId: 14,
          lastVerifiedHmac: "hmac-14",
          lastStatus: "ok",
        }),
      })
    );

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "audit.integrity_check",
        outcome: "success",
        detail: expect.objectContaining({
          scannedFrom: 11,
          scannedTo: 13,
          invalidCount: 0,
          chainBreakCount: 0,
          invalidIds: [],
          chainBreakIds: [],
        }),
      })
    );
    expect(getAuditIntegrityViolationCount()).toBe(0);
    // A clean run must never route through the audit-write-failure path.
    expect(mockRecordAuditFailure).not.toHaveBeenCalled();
  });

  it("violation: advances the checkpoint anyway, sets lastStatus='violation', emits failure audit + stderr + increments counter", async () => {
    mockCheckpointRow({ lastVerifiedId: 0, lastVerifiedHmac: null });
    mockVerifyIntegrity.mockResolvedValue({
      valid: false,
      totalChecked: 2,
      invalidIds: [2],
      chainBreakIds: [],
    });
    mockLastScannedRow("hmac-2");
    mockOwnReportRow(3, "hmac-3");
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const result = await sweepAuditVerify();

    expect(result.valid).toBe(false);
    // Checkpoint advances even on violation — no alarm-spam on every
    // subsequent cycle re-scanning the same tampered window.
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastVerifiedId: 3, lastStatus: "violation" })
    );
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({
        eventType: "audit.integrity_check",
        outcome: "failure",
        detail: expect.objectContaining({ invalidCount: 1, invalidIds: [2] }),
      })
    );
    const errorLines = stderrSpy.mock.calls.map((c) => c[0]).filter((l) => typeof l === "string");
    const parsed = errorLines.map((l) => JSON.parse(l as string));
    expect(parsed).toContainEqual(
      expect.objectContaining({
        level: "error",
        event: "audit_integrity_violation",
        invalidCount: 1,
        chainBreakCount: 0,
      })
    );
    expect(getAuditIntegrityViolationCount()).toBe(1);
    stderrSpy.mockRestore();
  });

  it("caps invalidIds/chainBreakIds in the emitted detail without affecting the reported counts", async () => {
    mockCheckpointRow({ lastVerifiedId: 0, lastVerifiedHmac: null });
    const manyIds = Array.from({ length: 80 }, (_, i) => i + 1);
    mockVerifyIntegrity.mockResolvedValue({
      valid: false,
      totalChecked: 80,
      invalidIds: manyIds,
      chainBreakIds: [],
    });
    mockLastScannedRow("hmac-80");
    mockOwnReportRow(81, "hmac-81");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await sweepAuditVerify();

    const call = mockAppendAuditLog.mock.calls[0][0];
    expect(call.detail.invalidCount).toBe(80);
    expect(call.detail.invalidIds.length).toBeLessThan(80);
  });

  it("audit-write failure inside the sweep is recorded via recordAuditFailure, not thrown, and the checkpoint still advances to the scanned window", async () => {
    mockCheckpointRow({ lastVerifiedId: 0, lastVerifiedHmac: null });
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 1,
      invalidIds: [],
      chainBreakIds: [],
    });
    mockLastScannedRow("hmac-1");
    mockAppendAuditLog.mockRejectedValueOnce(new Error("db down"));

    await expect(sweepAuditVerify()).resolves.toBeDefined();
    expect(mockRecordAuditFailure).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ eventType: "audit.integrity_check" })
    );
    // The audit write itself failed, so there's no "own report row" to fold
    // in — the checkpoint falls back to the actually-scanned window (row 1)
    // instead of silently not advancing at all.
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastVerifiedId: 1, lastVerifiedHmac: "hmac-1", lastStatus: "ok" })
    );
  });
});

describe("startAuditVerifyJob / stopAuditVerifyJob", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    mockCheckpointRow({ lastVerifiedId: 0, lastVerifiedHmac: null });
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 0,
      invalidIds: [],
      chainBreakIds: [],
    });
    stopAuditVerifyJob();
  });

  afterEach(() => {
    stopAuditVerifyJob();
    vi.useRealTimers();
  });

  it("_isAuditVerifyJobRunning reflects start/stop", () => {
    expect(_isAuditVerifyJobRunning()).toBe(false);
    startAuditVerifyJob();
    expect(_isAuditVerifyJobRunning()).toBe(true);
    stopAuditVerifyJob();
    expect(_isAuditVerifyJobRunning()).toBe(false);
  });

  it("fires once ~60s after start (startup kick) and then on the configured interval", async () => {
    startAuditVerifyJob();
    expect(mockVerifyIntegrity).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(mockVerifyIntegrity).toHaveBeenCalledTimes(1);
  });
});
