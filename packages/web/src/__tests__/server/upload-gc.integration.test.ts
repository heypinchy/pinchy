// Real-DB integration tests for sweepExpiredUploads().
//
// Uses a real PostgreSQL test database (provisioned by global-setup.ts and
// truncated between tests by setup.ts). File system I/O is redirected to a
// per-test temp directory via WORKSPACE_BASE_PATH env stubbing so no real
// openclaw-config directories are touched.
//
// What stays mocked: nothing extra — sweepExpiredUploads has no HTTP context.
// All DB writes, audit rows, and FS deletions run for real.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users, agents, uploadedFiles, auditLog } from "@/db/schema";

// ── Test-env overrides ─────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-gc-test-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
  // Restore any read-only dirs before cleanup so rmSync can delete them
  rmSync(tmpRoot, { recursive: true, force: true });
});

// ── Seed helpers ───────────────────────────────────────────────────────────

async function seedUser(overrides?: Partial<typeof users.$inferInsert>) {
  const [row] = await db
    .insert(users)
    .values({
      name: "Test User",
      email: `testuser-${Math.random().toString(36).slice(2)}@example.com`,
      emailVerified: true,
      role: "admin",
      ...overrides,
    })
    .returning();
  return row;
}

async function seedAgent(ownerId: string | null, overrides?: Partial<typeof agents.$inferInsert>) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "anthropic/claude-haiku-4-5-20251001",
      greetingMessage: "Hello!",
      isPersonal: false,
      visibility: "all",
      ownerId,
      ...overrides,
    })
    .returning();
  return row;
}

/**
 * Insert an uploadedFiles row AND create the staging directory + file on disk.
 *
 * stagingPath format: `.staging/<uploadId>/<filename>`
 * On disk layout: `<tmpRoot>/<agentId>/.staging/<uploadId>/<filename>`
 */
async function seedStagedUpload(
  userId: string,
  agentId: string,
  opts: {
    filename?: string;
    expiresAt?: Date;
    status?: "staged" | "attached";
  } = {}
) {
  const filename = opts.filename ?? "test.pdf";
  const buffer = Buffer.from("%PDF-1.4\n" + "x".repeat(64));
  const contentHash = createHash("sha256").update(buffer).digest("hex");
  const uploadId = crypto.randomUUID();
  const stagingPath = `.staging/${uploadId}/${filename}`;
  const expiresAt = opts.expiresAt ?? new Date(Date.now() + 60_000);
  const status = opts.status ?? "staged";

  const [row] = await db
    .insert(uploadedFiles)
    .values({
      id: uploadId,
      userId,
      agentId,
      draftId: `draft-${uploadId}`,
      filename,
      mimeType: "application/pdf",
      sizeBytes: buffer.length,
      contentHash,
      status,
      stagingPath,
      expiresAt,
    })
    .returning();

  // Write the staging directory + file to disk
  const stagingDir = join(tmpRoot, agentId, ".staging", uploadId);
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, filename), buffer);

  return row;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("sweepExpiredUploads", () => {
  it("sweeps 2 expired staged rows and leaves 1 non-expired staged row intact", async () => {
    const { sweepExpiredUploads } = await import("@/server/upload-gc");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const pastDate = new Date(Date.now() - 10_000); // already expired
    const futureDate = new Date(Date.now() + 60_000); // not yet expired

    const expired1 = await seedStagedUpload(user.id, agent.id, {
      filename: "expired1.pdf",
      expiresAt: pastDate,
    });
    const expired2 = await seedStagedUpload(user.id, agent.id, {
      filename: "expired2.pdf",
      expiresAt: pastDate,
    });
    const notExpired = await seedStagedUpload(user.id, agent.id, {
      filename: "not-expired.pdf",
      expiresAt: futureDate,
    });

    const result = await sweepExpiredUploads();

    expect(result.swept).toBe(2);
    expect(typeof result.sweepId).toBe("string");
    expect(result.sweepId.length).toBeGreaterThan(0);

    // Expired rows must be deleted from DB
    const remaining = await db.select().from(uploadedFiles);
    const remainingIds = remaining.map((r) => r.id);
    expect(remainingIds).not.toContain(expired1.id);
    expect(remainingIds).not.toContain(expired2.id);
    expect(remainingIds).toContain(notExpired.id);
  });

  it("both swept rows emit file.upload.expired audit rows with the SAME sweepId", async () => {
    const { sweepExpiredUploads } = await import("@/server/upload-gc");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const pastDate = new Date(Date.now() - 10_000);

    await seedStagedUpload(user.id, agent.id, {
      filename: "file-a.pdf",
      expiresAt: pastDate,
    });
    await seedStagedUpload(user.id, agent.id, {
      filename: "file-b.pdf",
      expiresAt: pastDate,
    });

    const result = await sweepExpiredUploads();

    expect(result.swept).toBe(2);

    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "file.upload.expired"));

    expect(auditRows).toHaveLength(2);

    for (const row of auditRows) {
      expect(row.outcome).toBe("success");
      const detail = row.detail as Record<string, unknown>;
      expect(detail.sweepId).toBe(result.sweepId);
      expect(typeof detail.uploadId).toBe("string");
      expect(typeof detail.filename).toBe("string");
      expect(typeof detail.sizeBytes).toBe("number");
      expect(typeof detail.agedSeconds).toBe("number");
      expect(detail.agedSeconds as number).toBeGreaterThanOrEqual(0);
    }

    // All audit rows in this run share the same sweepId
    const sweepIds = auditRows.map((r) => (r.detail as Record<string, unknown>).sweepId);
    expect(new Set(sweepIds).size).toBe(1);
  });

  it("removes the staging directory from disk for each swept file", async () => {
    const { sweepExpiredUploads } = await import("@/server/upload-gc");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const pastDate = new Date(Date.now() - 10_000);

    const row = await seedStagedUpload(user.id, agent.id, {
      filename: "to-delete.pdf",
      expiresAt: pastDate,
    });

    // Confirm staging dir exists before sweep
    const uploadId = row.id;
    const stagingDir = join(tmpRoot, agent.id, ".staging", uploadId);
    expect(existsSync(stagingDir)).toBe(true);

    await sweepExpiredUploads();

    // Staging dir must be gone
    expect(existsSync(stagingDir)).toBe(false);
  });

  it("never sweeps attached rows even if expiresAt is in the past", async () => {
    const { sweepExpiredUploads } = await import("@/server/upload-gc");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const pastDate = new Date(Date.now() - 10_000);

    // An attached row with an old expiresAt (shouldn't happen in practice but
    // the GC must be safe regardless)
    const attached = await seedStagedUpload(user.id, agent.id, {
      filename: "attached.pdf",
      expiresAt: pastDate,
      status: "attached",
    });

    const result = await sweepExpiredUploads();

    // Nothing should be swept
    expect(result.swept).toBe(0);

    // Attached row must still exist
    const rows = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, attached.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("attached");
  });

  it("emits audit failure and continues when rm fails for one file", async () => {
    const { sweepExpiredUploads } = await import("@/server/upload-gc");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const pastDate = new Date(Date.now() - 10_000);

    const failRow = await seedStagedUpload(user.id, agent.id, {
      filename: "fail.pdf",
      expiresAt: pastDate,
    });
    const okRow = await seedStagedUpload(user.id, agent.id, {
      filename: "ok.pdf",
      expiresAt: pastDate,
    });

    // Simulate an rm failure by pre-removing the staging directory for failRow.
    // sweepExpiredUploads uses async rm with force:false, so an ENOENT on the
    // missing directory is a genuine rm failure — the GC must emit an audit
    // failure row and continue to the next file.
    const failUploadId = failRow.id;
    const failStagingDir = join(tmpRoot, agent.id, ".staging", failUploadId);
    rmSync(failStagingDir, { recursive: true, force: true });

    const result = await sweepExpiredUploads();

    // The ok file should be swept even though fail file errored
    expect(result!.swept).toBe(1);

    // Audit: one failure row for failRow, one success row for okRow
    const auditRows = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "file.upload.expired"));

    expect(auditRows).toHaveLength(2);

    const failAudit = auditRows.find((r) => r.outcome === "failure");
    const successAudit = auditRows.find((r) => r.outcome === "success");

    expect(failAudit).toBeDefined();
    expect(successAudit).toBeDefined();

    const failDetail = failAudit!.detail as Record<string, unknown>;
    expect(failDetail.uploadId).toBe(failRow.id);
    expect(typeof failDetail.reason).toBe("string");
    expect(typeof failDetail.sweepId).toBe("string");

    const successDetail = successAudit!.detail as Record<string, unknown>;
    expect(successDetail.uploadId).toBe(okRow.id);

    // Both rows in the same sweep share the same sweepId
    expect(failDetail.sweepId).toBe(successDetail.sweepId);

    // okRow must be deleted from DB
    const remaining = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, okRow.id));
    expect(remaining).toHaveLength(0);
  });

  it("does NOT delete uploads/<filename> when the staging dir is gone (concurrent-promote race)", async () => {
    // Race scenario: between the GC's SELECT and the FS cleanup, a concurrent
    // `materializeAttachments` call promoted the staged file. After promote:
    //   - `.staging/<uploadId>/` is gone (promoteStagedToAttached rm'd it)
    //   - `uploads/<filename>` now holds the durable attached file
    //   - row.status flipped to 'attached' (but the GC snapshot still says
    //     'staged' because the SELECT ran first)
    //
    // The GC MUST detect this by failing the staging-dir rm (ENOENT), and
    // MUST NOT proceed to delete `uploads/<filename>` — that would erase the
    // user's just-attached file.
    const { sweepExpiredUploads } = await import("@/server/upload-gc");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const pastDate = new Date(Date.now() - 10_000);
    const stagedRow = await seedStagedUpload(user.id, agent.id, {
      filename: "racy.pdf",
      expiresAt: pastDate,
    });

    // Simulate the concurrent promote that ran between the GC's SELECT and
    // its cleanup phase:
    //   1. staging dir is gone
    //   2. uploads/<filename> holds the durable file with attached content
    //   3. row.status would be 'attached' in production — but here we leave
    //      it 'staged' so the row stays in the GC's snapshot, exactly as it
    //      would have been at the moment the SELECT ran. (Updating it to
    //      'attached' would just filter it out of the SELECT and make the
    //      test trivially pass for the wrong reason.)
    rmSync(join(tmpRoot, agent.id, ".staging", stagedRow.id), { recursive: true, force: true });
    mkdirSync(join(tmpRoot, agent.id, "uploads"), { recursive: true });
    const durableFile = join(tmpRoot, agent.id, "uploads", "racy.pdf");
    writeFileSync(durableFile, Buffer.from("DURABLE ATTACHED CONTENT"));

    await sweepExpiredUploads();

    // The durable attached file must still exist — GC must have backed off
    // when it saw the staging dir was gone.
    expect(existsSync(durableFile)).toBe(true);
  });
});
