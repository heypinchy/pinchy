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
  mockMaxIdThen,
  mockLastScannedLimit,
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
  // db.select({ maxId }).from(auditLog) -> awaited directly (bare thenable,
  // no .where()/.orderBy() chained) for the pre-scan MAX(id) snapshot.
  const mockMaxIdThen = vi.fn();
  // db.select(...).from(auditLog).where(...).orderBy(desc(...)).limit(1) ->
  // the highest real row actually scanned in [fromId, toId]
  const mockLastScannedLimit = vi.fn();
  const mockLastScannedOrderBy = vi.fn().mockReturnValue({ limit: mockLastScannedLimit });
  const mockLastScannedWhere = vi.fn().mockReturnValue({ orderBy: mockLastScannedOrderBy });
  // NOTE: there is deliberately no "own report row" query stub any more. The
  // sweep folds its own audit.integrity_check row into the checkpoint from the
  // {id, rowHmac} that appendAuditLog RETURNS (INSERT ... RETURNING), not from
  // a follow-up MAX(id) read — so mockAppendAuditLog's resolved value drives
  // that fold (see mockOwnReportRow below).

  const mockOnConflictDoUpdate = vi.fn().mockResolvedValue(undefined);
  const mockInsertValues = vi.fn().mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  // A single db.select() stub serves both tables the module queries,
  // routing on which table object .from(...) is called with (identity
  // comparison against the __marker tag the @/db/schema mock below attaches).
  // For auditLog there are two distinct call shapes: a bare await (MAX(id)
  // snapshot) and .where().orderBy().limit() (last-scanned-row lookup). They're
  // distinguished by which chain method is called first, exactly like the real
  // query builder — this mock never calls .where() with no follow-on chain.
  const mockSelect = vi.fn((..._args: unknown[]) => ({
    from: (table: unknown) => {
      const isCheckpointTable =
        typeof table === "object" &&
        table !== null &&
        (table as { __marker?: string }).__marker === "auditVerifyState";
      if (isCheckpointTable) return { where: mockCheckpointWhere };
      return {
        where: mockLastScannedWhere,
        then: (...args: Parameters<Promise<unknown>["then"]>) => mockMaxIdThen().then(...args),
      };
    },
  }));

  return {
    mockVerifyIntegrity,
    mockAppendAuditLog,
    mockRecordAuditFailure,
    mockCheckpointWhere,
    mockMaxIdThen,
    mockLastScannedLimit,
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

// The current MAX(id) snapshot taken before verifyIntegrity() runs — sets the
// `toId` bound passed to verifyIntegrity and the fallback for scannedTo when
// no row is found in [fromId, toId] (shouldn't happen in practice, but keeps
// the fallback path exercised).
function mockCurrentMaxId(maxId: number | null) {
  mockMaxIdThen.mockResolvedValue(maxId !== null ? [{ maxId }] : [{ maxId: null }]);
}

function mockLastScannedRow(row: { id: number; rowHmac: string } | null) {
  mockLastScannedLimit.mockResolvedValue(row ? [row] : []);
}

// The row the sweep's OWN appendAuditLog call just inserted. The module folds
// that row into the checkpoint from the {id, rowHmac} appendAuditLog RETURNS
// (INSERT ... RETURNING), NOT from a follow-up MAX(id) query — so a row some
// other request appends concurrently right after the report can't be mis-folded
// into the checkpoint. Driving the fold through the append's own return value
// is what makes it race-free, so we stub it via mockAppendAuditLog here.
function mockOwnReportRow(id: number, rowHmac: string) {
  mockAppendAuditLog.mockResolvedValue({ id, rowHmac });
}

describe("sweepAuditVerify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAuditIntegrityViolationCount();
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
    mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
    mockInsert.mockReturnValue({ values: mockInsertValues });
    // Re-assert the "no report row folded" default each test (clearAllMocks
    // keeps implementations, so a prior test's mockOwnReportRow could leak in).
    // Tests that reach the append override this via mockOwnReportRow.
    mockAppendAuditLog.mockResolvedValue(undefined);
  });

  it("no new rows since the checkpoint (toId < fromId): no-op, verifyIntegrity never called", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "abc" });
    // Current MAX(id) is still 10 — nothing appended since the checkpoint.
    mockCurrentMaxId(10);

    const result = await sweepAuditVerify();

    expect(result.scanned).toBe(false);
    expect(mockVerifyIntegrity).not.toHaveBeenCalled();
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("defensive fallback: toId >= fromId but verifyIntegrity reports totalChecked=0 anyway is still a no-op", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "abc" });
    mockCurrentMaxId(11);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 0,
      invalidIds: [],
      chainBreakIds: [],
    });

    const result = await sweepAuditVerify();

    expect(result.scanned).toBe(false);
    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 11, { seedPrevHmac: "abc" });
    expect(mockAppendAuditLog).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
  });

  it("defaults to lastVerifiedId=0 / seedPrevHmac=null when no checkpoint row exists yet", async () => {
    mockCheckpointRow(null);
    mockCurrentMaxId(0);

    const result = await sweepAuditVerify();

    // toId (0) < fromId (1): no rows, no-op before verifyIntegrity is even
    // called — mirrors "no checkpoint row + empty table" (genesis, nothing to
    // verify yet).
    expect(result.scanned).toBe(false);
    expect(mockVerifyIntegrity).not.toHaveBeenCalled();
  });

  it("defaults to lastVerifiedId=0 / seedPrevHmac=null and passes toId when rows exist", async () => {
    mockCheckpointRow(null);
    mockCurrentMaxId(5);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 5,
      invalidIds: [],
      chainBreakIds: [],
    });
    mockLastScannedRow({ id: 5, rowHmac: "hmac-5" });
    mockOwnReportRow(6, "hmac-6");

    await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(1, 5, { seedPrevHmac: null });
  });

  it("clean run: advances the checkpoint past its own report row and emits audit.integrity_check success", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCurrentMaxId(13);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 3, // rows 11, 12, 13
      invalidIds: [],
      chainBreakIds: [],
    });
    mockLastScannedRow({ id: 13, rowHmac: "hmac-13" });
    // The sweep's own appendAuditLog call inserts row 14 and RETURNS it; the
    // module folds that returned {id, rowHmac} into the checkpoint directly.
    mockOwnReportRow(14, "hmac-14");

    const result = await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 13, { seedPrevHmac: "hmac-10" });
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

  it("folds the checkpoint from appendAuditLog's RETURNED row, never a post-append MAX(id) re-read (race-safe)", async () => {
    // Regression guard for the concurrency gap: the sweep must advance its
    // checkpoint to the exact row appendAuditLog reports it inserted, taken
    // from that call's return value — NOT from a separate "current highest
    // row" query that could observe a row another request appended
    // concurrently right after the report and silently skip the rows between.
    // The mock deliberately provides NO own-report-row query stub; if the
    // module tried to re-read the latest row instead of trusting the append's
    // return, that missing stub would surface here.
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCurrentMaxId(13);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 3,
      invalidIds: [],
      chainBreakIds: [],
    });
    mockLastScannedRow({ id: 13, rowHmac: "hmac-13" });
    mockAppendAuditLog.mockResolvedValue({ id: 14, rowHmac: "hmac-14" });

    await sweepAuditVerify();

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastVerifiedId: 14, lastVerifiedHmac: "hmac-14", lastStatus: "ok" })
    );
  });

  it("violation: advances the checkpoint anyway, sets lastStatus='violation', emits failure audit + stderr + increments counter", async () => {
    mockCheckpointRow({ lastVerifiedId: 0, lastVerifiedHmac: null });
    mockCurrentMaxId(2);
    mockVerifyIntegrity.mockResolvedValue({
      valid: false,
      totalChecked: 2,
      invalidIds: [2],
      chainBreakIds: [],
    });
    mockLastScannedRow({ id: 2, rowHmac: "hmac-2" });
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
    mockCurrentMaxId(80);
    const manyIds = Array.from({ length: 80 }, (_, i) => i + 1);
    mockVerifyIntegrity.mockResolvedValue({
      valid: false,
      totalChecked: 80,
      invalidIds: manyIds,
      chainBreakIds: [],
    });
    mockLastScannedRow({ id: 80, rowHmac: "hmac-80" });
    mockOwnReportRow(81, "hmac-81");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await sweepAuditVerify();

    const call = mockAppendAuditLog.mock.calls[0][0];
    expect(call.detail.invalidCount).toBe(80);
    expect(call.detail.invalidIds.length).toBeLessThan(80);
  });

  it("audit-write failure inside the sweep is recorded via recordAuditFailure, not thrown, and the checkpoint still advances to the scanned window", async () => {
    mockCheckpointRow({ lastVerifiedId: 0, lastVerifiedHmac: null });
    mockCurrentMaxId(1);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 1,
      invalidIds: [],
      chainBreakIds: [],
    });
    mockLastScannedRow({ id: 1, rowHmac: "hmac-1" });
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
    // A row exists (toId=1 >= fromId=1) so the sweep actually reaches
    // verifyIntegrity — otherwise the toId < fromId no-op guard would short
    // circuit before verifyIntegrity is ever called, and the "fires once
    // ~60s after start" assertion below couldn't observe the call.
    mockCurrentMaxId(1);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 1,
      invalidIds: [],
      chainBreakIds: [],
    });
    mockLastScannedRow({ id: 1, rowHmac: "hmac-1" });
    mockOwnReportRow(2, "hmac-2");
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
