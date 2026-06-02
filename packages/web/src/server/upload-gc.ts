import { rm } from "fs/promises";
import { join } from "path";
import { and, eq, isNotNull, lt } from "drizzle-orm";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { getWorkspacePath } from "@/lib/workspace";

export interface SweepResult {
  swept: number;
  sweepId: string;
}

/**
 * Garbage-collect staged upload orphans.
 *
 * Finds all `uploaded_files` rows with `status='staged'` and `expires_at <
 * now`, deletes the staging directory from disk, and removes the DB row.
 * Emits a `file.upload.expired` audit row for each processed file.
 *
 * A single `sweepId` UUID is generated per run and shared across all audit
 * rows so a single GC sweep can be correlated in the audit trail
 * (OCSF metadata.correlation_uid pattern).
 *
 * Failure handling: if the FS rm fails for a file, an audit failure row is
 * emitted and the sweep continues to the next row. A failed rm does NOT
 * delete the DB row — the GC will retry on the next sweep cycle.
 */
export async function sweepExpiredUploads(): Promise<SweepResult> {
  const sweepId = crypto.randomUUID();
  const now = new Date();

  const expiredRows = await db
    .select()
    .from(uploadedFiles)
    .where(
      and(
        eq(uploadedFiles.status, "staged"),
        lt(uploadedFiles.expiresAt, now),
        isNotNull(uploadedFiles.stagingPath)
      )
    );

  let swept = 0;

  for (const row of expiredRows) {
    const uploadId = row.id;
    // Clamp at 0 — Postgres `now()` (the createdAt default) and JS `Date.now()`
    // are different clocks, so a sub-second skew can make the floored diff
    // land at -1 even though the row is logically older than the sweep start.
    // An "age" can't be negative; surface 0 instead of leaking the skew into
    // the audit row.
    const agedSeconds = Math.max(0, Math.floor((now.getTime() - row.createdAt.getTime()) / 1000));

    // Derive the staging directory path:
    // stagingPath format: `.staging/<uploadId>/<filename>`
    // The directory to remove is: `<workspaceRoot>/.staging/<uploadId>/`
    const workspaceRoot = getWorkspacePath(row.agentId);
    // stagingPath format: `.staging/<uploadId>/<filename>` — extract the uploadId
    // segment explicitly rather than relying on dirname(), which would silently
    // target the wrong level if the format ever gains additional path components.
    const stagingUploadId = row.stagingPath!.split("/")[1];
    const stagingDir = join(workspaceRoot, ".staging", stagingUploadId);

    // Attempt to remove the staging directory. Uses async `rm` so a backlog
    // of expired uploads doesn't block the event loop for the entire sweep —
    // each iteration yields between FS calls.
    //
    // Successful staging-dir removal is the GC's atomic "claim" on this row.
    // The placeholder rm and DB delete only run inside the success branch.
    // If the staging dir is gone, either (a) a concurrent `materializeAttachments`
    // promoted the file between our SELECT and this rm — in which case
    // `uploads/<filename>` now holds the user's attached file and we MUST
    // NOT touch it — or (b) someone deleted the dir out-of-band; that
    // orphan is fixed by an operator, not by us blindly racing on the
    // uploads/ slot.
    let rmFailed = false;
    let rmError: unknown;
    try {
      // force: false so a missing directory surfaces as an error and triggers
      // the audit failure path below rather than silently succeeding.
      await rm(stagingDir, { recursive: true, force: false });
    } catch (err) {
      rmFailed = true;
      rmError = err;
    }

    if (rmFailed) {
      const failureEntry = {
        eventType: "file.upload.expired" as const,
        actorType: "system" as const,
        actorId: "upload-gc",
        outcome: "failure" as const,
        detail: {
          uploadId,
          filename: row.filename,
          sweepId,
          reason: rmError instanceof Error ? rmError.message : String(rmError),
        },
      };
      try {
        await appendAuditLog(failureEntry);
      } catch (auditErr) {
        recordAuditFailure(auditErr, failureEntry);
      }
      // Do NOT delete the DB row — the GC will retry on the next cycle
      continue;
    }

    // Staging rm succeeded — we now own this row. Also remove the
    // `uploads/<filename>` slot that `persistStagedUpload` reserved at upload
    // time so the staged filename frees up for reuse. `force: true` swallows
    // ENOENT (someone removed it out-of-band) — non-ENOENT errors leave the
    // slot orphaned, but the DB row gets deleted regardless so the orphan
    // surfaces only as a manual cleanup, not as a permanent failure loop.
    try {
      await rm(join(workspaceRoot, "uploads", row.filename), { force: true });
    } catch {
      // Best-effort: see comment above.
    }

    // FS rm succeeded — delete the DB row.
    // If the delete fails (transient DB error), the file is already gone from
    // disk. We emit a failure audit row and skip the success audit + swept++
    // so the operator is alerted. The row will be retried on the next GC
    // cycle, where rm will throw ENOENT and produce another failure audit
    // until the DB row is manually removed or the DB recovers.
    try {
      await db.delete(uploadedFiles).where(eq(uploadedFiles.id, uploadId));
    } catch (dbErr) {
      const dbFailEntry = {
        eventType: "file.upload.expired" as const,
        actorType: "system" as const,
        actorId: "upload-gc",
        outcome: "failure" as const,
        detail: {
          uploadId,
          filename: row.filename,
          sweepId,
          reason: `DB delete failed after rm: ${dbErr instanceof Error ? dbErr.message : String(dbErr)}`,
        },
      };
      try {
        await appendAuditLog(dbFailEntry);
      } catch (auditErr) {
        recordAuditFailure(auditErr, dbFailEntry);
      }
      continue;
    }

    // Emit success audit row
    const successEntry = {
      eventType: "file.upload.expired" as const,
      actorType: "system" as const,
      actorId: "upload-gc",
      outcome: "success" as const,
      detail: {
        uploadId,
        filename: row.filename,
        sizeBytes: row.sizeBytes,
        agedSeconds,
        sweepId,
      },
    };
    try {
      await appendAuditLog(successEntry);
    } catch (auditErr) {
      recordAuditFailure(auditErr, successEntry);
    }

    swept++;
  }

  return { swept, sweepId };
}

const GC_INTERVAL_MS = 60 * 60 * 1000;

let _gcInterval: ReturnType<typeof setInterval> | null = null;
let _gcStartupTimeout: ReturnType<typeof setTimeout> | null = null;

export function startUploadGc(): void {
  _gcInterval = setInterval(() => {
    sweepExpiredUploads().catch((err) => console.error("[upload-gc] sweep failed:", err));
  }, GC_INTERVAL_MS);

  _gcStartupTimeout = setTimeout(() => {
    _gcStartupTimeout = null;
    sweepExpiredUploads().catch((err) => console.error("[upload-gc] sweep failed:", err));
  }, 30_000);
}

export function stopUploadGc(): void {
  if (_gcInterval !== null) {
    clearInterval(_gcInterval);
    _gcInterval = null;
  }
  if (_gcStartupTimeout !== null) {
    clearTimeout(_gcStartupTimeout);
    _gcStartupTimeout = null;
  }
}

// Test-only helper (mirrors usage-poller pattern)
export function _isGcRunning(): boolean {
  return _gcInterval !== null;
}
