// @vitest-environment jsdom
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
  mockRacedRowLimit,
  mockInsertValues,
  mockOnConflictDoUpdate,
  mockInsert,
  mockSelect,
  mockReadAuditRowKey,
} = vi.hoisted(() => {
  const mockVerifyIntegrity = vi.fn();
  // The checkpoint row, read once: its rowHmac as stored now and which key it
  // verifies under, recomputed now.
  const mockReadAuditRowKey = vi.fn();
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
  // db.select(...).from(auditLog).where(...).limit(1) -> the #698 concurrency
  // probe: any row another request appended in (toId, reportId). Shares the
  // `where` stub with the last-scanned lookup above and is told apart by which
  // chain method follows — .orderBy().limit() vs a bare .limit() — exactly
  // like the real query builder.
  const mockRacedRowLimit = vi.fn().mockResolvedValue([]);
  const mockLastScannedOrderBy = vi.fn().mockReturnValue({ limit: mockLastScannedLimit });
  const mockLastScannedWhere = vi.fn().mockReturnValue({
    orderBy: mockLastScannedOrderBy,
    limit: mockRacedRowLimit,
  });
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
  // For auditLog there are three distinct call shapes: a bare await (MAX(id)
  // snapshot), .where().orderBy().limit() (last-scanned-row lookup) and
  // .where().limit() (the #698 concurrency probe). They're distinguished by
  // which chain method follows, exactly like the real query builder.
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
    mockRacedRowLimit,
    mockInsertValues,
    mockOnConflictDoUpdate,
    mockInsert,
    mockSelect,
    mockReadAuditRowKey,
  };
});

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    verifyIntegrity: mockVerifyIntegrity,
    appendAuditLog: mockAppendAuditLog,
    readAuditRowKey: mockReadAuditRowKey,
    // Pure: the real rule, so these tests pin the sweep's wiring of it.
    keyChangeSeenAfter: actual.keyChangeSeenAfter,
  };
});

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
} from "@/server/audit-verify-job";

function mockCheckpointRow(
  row: { lastVerifiedId: number; lastVerifiedHmac: string | null } | null
) {
  mockCheckpointWhere.mockResolvedValue(row ? [row] : []);
  // By default the audit row the checkpoint points at is still there and
  // unchanged, and still pre-rotation (signed under the previous key, so the
  // seed stays false). The tests for a deleted or altered checkpoint row, or
  // one under another key, override this with mockCheckpointAuditRow afterwards.
  mockCheckpointAuditRow(
    row && row.lastVerifiedHmac !== null ? { rowHmac: row.lastVerifiedHmac, key: "previous" } : null
  );
}

// The audit_log row at the checkpoint's lastVerifiedId, as it is now: its stored
// rowHmac and which key it verifies under. null = the row is gone.
function mockCheckpointAuditRow(
  row: {
    rowHmac: string;
    key: "active" | "previous" | "neither" | "unknown-version";
  } | null
) {
  mockReadAuditRowKey.mockResolvedValue(row ?? { key: "missing", rowHmac: null });
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

// Whether another request appended a row in (toId, reportId) — the #698 window
// between the sweep's MAX(id) snapshot and its own report row. `null` is the
// normal case (nobody raced us).
function mockRacedRow(row: { id: number } | null) {
  mockRacedRowLimit.mockResolvedValue(row ? [row] : []);
}

describe("sweepAuditVerify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockOnConflictDoUpdate.mockResolvedValue(undefined);
    mockInsertValues.mockReturnValue({ onConflictDoUpdate: mockOnConflictDoUpdate });
    mockInsert.mockReturnValue({ values: mockInsertValues });
    // Re-assert the "no report row folded" default each test (clearAllMocks
    // keeps implementations, so a prior test's mockOwnReportRow could leak in).
    // Tests that reach the append override this via mockOwnReportRow.
    mockAppendAuditLog.mockResolvedValue(undefined);
    mockRacedRow(null);
    mockReadAuditRowKey.mockResolvedValue({ key: "missing", rowHmac: null });
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
      previousKeyIds: [],
    });

    const result = await sweepAuditVerify();

    expect(result.scanned).toBe(false);
    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 11, {
      seedPrevHmac: "abc",
      seedActiveKeySeen: false,
      seedPredecessorBroken: false,
    });
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
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 5, rowHmac: "hmac-5" });
    mockOwnReportRow(6, "hmac-6");

    await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(1, 5, {
      seedPrevHmac: null,
      seedActiveKeySeen: false,
      seedPredecessorBroken: false,
    });
  });

  it("clean run: advances the checkpoint past its own report row and emits audit.integrity_check success", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCurrentMaxId(13);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 3, // rows 11, 12, 13
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 13, rowHmac: "hmac-13" });
    // The sweep's own appendAuditLog call inserts row 14 and RETURNS it; the
    // module folds that returned {id, rowHmac} into the checkpoint directly.
    mockOwnReportRow(14, "hmac-14");

    const result = await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 13, {
      seedPrevHmac: "hmac-10",
      seedActiveKeySeen: false,
      seedPredecessorBroken: false,
    });
    expect(result).toEqual({
      scanned: true,
      scannedFrom: 11,
      scannedTo: 13,
      valid: true,
      invalidCount: 0,
      chainBreakCount: 0,
      previousKeyCount: 0,
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
          previousKeyCount: 0,
        }),
      })
    );
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
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 13, rowHmac: "hmac-13" });
    mockAppendAuditLog.mockResolvedValue({ id: 14, rowHmac: "hmac-14" });

    await sweepAuditVerify();

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastVerifiedId: 14, lastVerifiedHmac: "hmac-14", lastStatus: "ok" })
    );
  });

  it("concurrent append during the verify pass: folds only to the scanned window so the raced rows are re-scanned (#698)", async () => {
    // Another request appended row 14 between the toId=13 snapshot and this
    // sweep's own report row (id 16). Row 14 is outside the scanned window
    // (> toId) — and folding the checkpoint to 16 would put it BELOW the next
    // sweep's start too, so the incremental job would never verify it. The
    // sweep therefore folds only to the window it really scanned.
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCurrentMaxId(13);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 3,
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 13, rowHmac: "hmac-13" });
    mockOwnReportRow(16, "hmac-16");
    mockRacedRow({ id: 14 });

    const result = await sweepAuditVerify();

    // The report itself still describes the window that was actually scanned.
    expect(result.scannedTo).toBe(13);
    // Checkpoint stays at row 13, so the next sweep re-scans [14, …] — the
    // raced rows AND this sweep's own report row. One extra non-converged
    // sweep, then the steady state is a no-op again.
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastVerifiedId: 13, lastVerifiedHmac: "hmac-13", lastStatus: "ok" })
    );
    expect(mockOnConflictDoUpdate).toHaveBeenCalledWith(
      expect.objectContaining({
        set: expect.objectContaining({ lastVerifiedId: 13, lastVerifiedHmac: "hmac-13" }),
      })
    );
    // The append succeeded — a deferred fold is not an audit-write failure.
    expect(mockRecordAuditFailure).not.toHaveBeenCalled();
  });

  it("report row not adjacent to the snapshot but the gap is empty (sequence gap): still folds past its own report", async () => {
    // A rolled-back transaction burned ids 14–15, so the report row lands at
    // 16 without anyone racing us. The probe finds nothing, so this is the
    // normal converging fold — a sequence gap must not be mistaken for
    // concurrency and cost a redundant re-scan every sweep.
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCurrentMaxId(13);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 3,
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 13, rowHmac: "hmac-13" });
    mockOwnReportRow(16, "hmac-16");
    mockRacedRow(null);

    await sweepAuditVerify();

    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastVerifiedId: 16, lastVerifiedHmac: "hmac-16", lastStatus: "ok" })
    );
  });

  it("report row immediately follows the snapshot: no concurrency probe query is issued at all", async () => {
    // reportId === toId + 1 leaves no id strictly between the two, so the
    // common (uncontended) case must not pay for an extra round trip.
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCurrentMaxId(13);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 3,
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 13, rowHmac: "hmac-13" });
    mockOwnReportRow(14, "hmac-14");

    await sweepAuditVerify();

    expect(mockRacedRowLimit).not.toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastVerifiedId: 14, lastVerifiedHmac: "hmac-14" })
    );
  });

  it("concurrency probe query fails: still advances the checkpoint, folding conservatively to the scanned window", async () => {
    // The probe runs AFTER the report row is already written, so letting its
    // error escape would leave the checkpoint behind entirely — and the next
    // sweep would re-scan and re-report the very same window. Treat an
    // unanswerable probe as "assume someone raced us": never skips a row.
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCurrentMaxId(13);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 3,
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 13, rowHmac: "hmac-13" });
    mockOwnReportRow(16, "hmac-16");
    mockRacedRowLimit.mockRejectedValueOnce(new Error("db blip"));
    const stderrSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(sweepAuditVerify()).resolves.toBeDefined();

    expect(mockRacedRowLimit).toHaveBeenCalled();
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastVerifiedId: 13, lastVerifiedHmac: "hmac-13", lastStatus: "ok" })
    );
    // A failed probe is not an audit-write failure — the audit row went in.
    expect(mockRecordAuditFailure).not.toHaveBeenCalled();
    // …but it is not swallowed silently either.
    expect(stderrSpy).toHaveBeenCalled();
    stderrSpy.mockRestore();
  });

  it("violation: advances the checkpoint anyway, sets lastStatus='violation', emits failure audit + stderr", async () => {
    mockCheckpointRow({ lastVerifiedId: 0, lastVerifiedHmac: null });
    mockCurrentMaxId(2);
    mockVerifyIntegrity.mockResolvedValue({
      valid: false,
      totalChecked: 2,
      invalidIds: [2],
      chainBreakIds: [],
      previousKeyIds: [],
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
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 80, rowHmac: "hmac-80" });
    mockOwnReportRow(81, "hmac-81");
    vi.spyOn(console, "error").mockImplementation(() => {});

    await sweepAuditVerify();

    const call = mockAppendAuditLog.mock.calls[0][0];
    expect(call.detail.invalidCount).toBe(80);
    expect(call.detail.invalidIds.length).toBeLessThan(80);
  });

  it("seeds verifyIntegrity with whether the checkpoint row is already signed under the active key", async () => {
    // The previous key is only valid before a rotation. A window cannot see the
    // rows before it, so the sweep answers for it from the checkpoint row.
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCheckpointAuditRow({ rowHmac: "hmac-10", key: "active" });
    mockCurrentMaxId(11);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 1,
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 11, rowHmac: "hmac-11" });
    mockOwnReportRow(12, "hmac-12");

    await sweepAuditVerify();

    // One read of the checkpoint row answers both questions (intact? which key?),
    // so nothing can change the row between them.
    expect(mockReadAuditRowKey).toHaveBeenCalledTimes(1);
    expect(mockReadAuditRowKey).toHaveBeenCalledWith(10);
    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 11, {
      seedPrevHmac: "hmac-10",
      seedActiveKeySeen: true,
      seedPredecessorBroken: false,
    });
  });

  // The checkpoint stores the rowHmac of the row it ends on, so the next window's
  // first link is checked against the remembered value. That says nothing about
  // the checkpoint row itself: if it was deleted or rewritten since, the link
  // still matches the remembered value and the seed above would be read off
  // whatever the row has become. A row re-signed with the old key would then
  // re-open the previous-key window for everything after it.
  it("altered checkpoint row: reports the window's boundary link as broken and seeds the key change as already seen", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    // Re-signed with the old key: it verifies, but its rowHmac is not the one
    // the sweep remembered.
    mockCheckpointAuditRow({ rowHmac: "hmac-10-rewritten", key: "previous" });
    mockCurrentMaxId(11);
    mockVerifyIntegrity.mockResolvedValue({
      valid: false,
      totalChecked: 1,
      invalidIds: [],
      chainBreakIds: [11],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 11, rowHmac: "hmac-11" });
    mockOwnReportRow(12, "hmac-12");

    const result = await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 11, {
      seedPrevHmac: "hmac-10",
      // Fail closed: what the row says about the key can't be trusted any more.
      seedActiveKeySeen: true,
      seedPredecessorBroken: true,
    });
    expect(result.valid).toBe(false);
    expect(result.chainBreakCount).toBe(1);
    expect(mockAppendAuditLog.mock.calls[0][0].outcome).toBe("failure");
    expect(mockInsertValues).toHaveBeenCalledWith(
      expect.objectContaining({ lastStatus: "violation" })
    );
  });

  it("deleted checkpoint row: reports the window's boundary link as broken and seeds the key change as already seen", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCheckpointAuditRow(null);
    mockCurrentMaxId(11);
    mockVerifyIntegrity.mockResolvedValue({
      valid: false,
      totalChecked: 1,
      invalidIds: [],
      chainBreakIds: [11],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 11, rowHmac: "hmac-11" });
    mockOwnReportRow(12, "hmac-12");

    await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 11, {
      seedPrevHmac: "hmac-10",
      seedActiveKeySeen: true,
      seedPredecessorBroken: true,
    });
  });

  function mockCleanOneRowWindow() {
    mockCurrentMaxId(11);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 1,
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 11, rowHmac: "hmac-11" });
    mockOwnReportRow(12, "hmac-12");
  }

  it("intact checkpoint row under the previous key: keeps the old key open for the window", async () => {
    // Only a row that positively verifies under the old key says the change
    // has not happened yet.
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCheckpointAuditRow({ rowHmac: "hmac-10", key: "previous" });
    mockCleanOneRowWindow();

    await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 11, {
      seedPrevHmac: "hmac-10",
      seedActiveKeySeen: false,
      seedPredecessorBroken: false,
    });
  });

  // Content-only tampering: someone with DB write access changes the checkpoint
  // row's content (trigger disabled) and leaves row_hmac alone. The stored hash
  // string still matches the remembered one, but the row verifies under no key.
  // Read as "not signed under the active key", that re-opened the old key for
  // the whole next window. Verifying under neither key means the change was
  // already seen.
  it("checkpoint row altered in place (rowHmac untouched): closes the old key for the window", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCheckpointAuditRow({ rowHmac: "hmac-10", key: "neither" });
    mockCleanOneRowWindow();

    await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 11, {
      seedPrevHmac: "hmac-10",
      seedActiveKeySeen: true,
      seedPredecessorBroken: false,
    });
  });

  // The same "neither" answer is what a legitimate checkpoint gives after a
  // second rotation: K2 signed it, K3 is active now and K1 is still the key
  // file. Calling that a broken link would record a permanent violation on an
  // install that did nothing wrong, and so would removing the retired key file
  // before the first sweep under the new key, which the docs recommend.
  it("checkpoint row signed under a key retired since: no chain break, report stays success", async () => {
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCheckpointAuditRow({ rowHmac: "hmac-10", key: "neither" });
    mockCleanOneRowWindow();

    const result = await sweepAuditVerify();

    expect(mockVerifyIntegrity.mock.calls[0][2].seedPredecessorBroken).toBe(false);
    expect(result.valid).toBe(true);
    expect(mockAppendAuditLog.mock.calls[0][0].outcome).toBe("success");
  });

  it("checkpoint row with an unknown version: reported as a broken link, old key closed", async () => {
    // No Pinchy writes a version its verifiers don't know, and verifyIntegrity
    // reports such a row as invalid under every key. The checkpoint was verified
    // once, so its version was changed since.
    mockCheckpointRow({ lastVerifiedId: 10, lastVerifiedHmac: "hmac-10" });
    mockCheckpointAuditRow({ rowHmac: "hmac-10", key: "unknown-version" });
    mockCleanOneRowWindow();

    await sweepAuditVerify();

    expect(mockVerifyIntegrity).toHaveBeenCalledWith(11, 11, {
      seedPrevHmac: "hmac-10",
      seedActiveKeySeen: true,
      seedPredecessorBroken: true,
    });
  });

  it("does not look up a checkpoint row on the very first sweep", async () => {
    mockCheckpointRow(null);
    mockCurrentMaxId(2);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 2,
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [],
    });
    mockLastScannedRow({ id: 2, rowHmac: "hmac-2" });
    mockOwnReportRow(3, "hmac-3");

    await sweepAuditVerify();

    expect(mockReadAuditRowKey).not.toHaveBeenCalled();
  });

  it("records rows verified under the superseded secret, and does NOT call it a violation", async () => {
    // The first sweep after an operator pins AUDIT_HMAC_SECRET straddles the
    // rotation: rows written before the restart carry the old signature. That
    // is a rotation, not tampering — so the report row stays `success`, and the
    // count is what makes the rotation durable evidence in the log itself
    // rather than a line on stderr nobody reads.
    mockCheckpointRow({ lastVerifiedId: 0, lastVerifiedHmac: null });
    mockCurrentMaxId(4);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 4,
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [1, 2],
    });
    mockLastScannedRow({ id: 4, rowHmac: "hmac-4" });
    mockOwnReportRow(5, "hmac-5");

    const result = await sweepAuditVerify();

    const call = mockAppendAuditLog.mock.calls[0][0];
    expect(call.outcome).toBe("success");
    expect(call.detail.previousKeyCount).toBe(2);
    expect(call.detail.previousKeyIds).toEqual([1, 2]);
    expect(result.previousKeyCount).toBe(2);
  });

  it("audit-write failure inside the sweep is recorded via recordAuditFailure, not thrown, and the checkpoint still advances to the scanned window", async () => {
    mockCheckpointRow({ lastVerifiedId: 0, lastVerifiedHmac: null });
    mockCurrentMaxId(1);
    mockVerifyIntegrity.mockResolvedValue({
      valid: true,
      totalChecked: 1,
      invalidIds: [],
      chainBreakIds: [],
      previousKeyIds: [],
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
      previousKeyIds: [],
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
