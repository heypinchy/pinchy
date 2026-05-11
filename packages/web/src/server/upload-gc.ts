import { rmSync } from "fs";
import { join, dirname } from "path";
import { and, eq, lt } from "drizzle-orm";
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
    .where(and(eq(uploadedFiles.status, "staged"), lt(uploadedFiles.expiresAt, now)));

  let swept = 0;

  for (const row of expiredRows) {
    const uploadId = row.id;
    const agedSeconds = Math.floor((now.getTime() - row.createdAt.getTime()) / 1000);

    // Derive the staging directory path:
    // stagingPath format: `.staging/<uploadId>/<filename>`
    // The directory to remove is: `<workspaceRoot>/.staging/<uploadId>/`
    const workspaceRoot = getWorkspacePath(row.agentId);
    let stagingDir: string;
    if (row.stagingPath) {
      // stagingPath = `.staging/<uploadId>/<filename>` — take the dir portion
      stagingDir = join(workspaceRoot, dirname(row.stagingPath));
    } else {
      // Fallback: construct the expected dir from the uploadId
      stagingDir = join(workspaceRoot, ".staging", uploadId);
    }

    // Attempt to remove the staging directory
    let rmFailed = false;
    let rmError: unknown;
    try {
      rmSync(stagingDir, { recursive: true, force: false });
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

    // FS rm succeeded — delete the DB row
    await db.delete(uploadedFiles).where(eq(uploadedFiles.id, uploadId));

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
