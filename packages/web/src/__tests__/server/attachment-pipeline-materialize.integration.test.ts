// Real-DB integration tests for materializeAttachments().
//
// Uses a real PostgreSQL test database (provisioned by global-setup.ts and
// truncated between tests by setup.ts). File system I/O is redirected to a
// per-test temp directory via WORKSPACE_BASE_PATH env stubbing.
//
// What stays mocked, and why:
//   - @/lib/auth — not needed; we call materializeAttachments directly.
//   - next/headers — same; no route handler involved.
//
// Everything else (DB writes to uploaded_files, audit_log; FS ops) runs for real.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createHash } from "crypto";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users, agents, uploadedFiles, auditLog } from "@/db/schema";

// ── Minimal valid test buffers ─────────────────────────────────────────────

// PNG header (1×1 pixel), enough for MIME sniffing
const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from([
    0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
    0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53, 0xde,
  ]),
  Buffer.alloc(64, 0),
]);

// Minimal valid PDF header
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n"), Buffer.alloc(128, 0)]);

// ── Test-env env overrides ─────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(() => {
  vi.clearAllMocks();
  tmpRoot = mkdtempSync(join(tmpdir(), "pinchy-materialize-test-"));
  vi.stubEnv("WORKSPACE_BASE_PATH", tmpRoot);
  vi.stubEnv("OPENCLAW_WORKSPACE_PREFIX", tmpRoot);
});

afterEach(() => {
  vi.unstubAllEnvs();
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
 * Insert an uploadedFiles row AND write the staged file to the temp FS so
 * promoteStagedToAttached finds it on disk.
 */
async function seedStagedUpload(
  userId: string,
  agentId: string,
  opts: {
    filename?: string;
    mimeType?: string;
    buffer?: Buffer;
    expiresAt?: Date | null;
    status?: "staged" | "attached";
    draftId?: string;
    messageId?: string;
  } = {}
) {
  const filename = opts.filename ?? "test.png";
  const mimeType = opts.mimeType ?? "image/png";
  const buffer = opts.buffer ?? PNG;
  const expiresAt = opts.expiresAt !== undefined ? opts.expiresAt : new Date(Date.now() + 60_000);
  const status = opts.status ?? "staged";
  const draftId = opts.draftId ?? "draft-1";

  const contentHash = createHash("sha256").update(buffer).digest("hex");

  // Insert DB row
  const [row] = await db
    .insert(uploadedFiles)
    .values({
      userId,
      agentId,
      draftId,
      filename,
      mimeType,
      sizeBytes: buffer.length,
      contentHash,
      status,
      stagingPath: `.staging/${draftId}/${filename}`,
      expiresAt,
      ...(opts.messageId !== undefined && { messageId: opts.messageId }),
    })
    .returning();

  // Write staged file to disk
  const stagingDir = join(tmpRoot, agentId, ".staging", draftId);
  mkdirSync(stagingDir, { recursive: true });
  writeFileSync(join(stagingDir, filename), buffer);

  return row;
}

/**
 * The state a message leaves behind once its attachments have been
 * materialized: the row is `attached` and stamped with the message id, and the
 * bytes sit in `uploads/<filename>` rather than `.staging/`.
 *
 * This is what a RETRY of that message meets (heypinchy/pinchy#1195), so it
 * needs its own seeder — `seedStagedUpload({ status: "attached" })` leaves the
 * file in `.staging/`, which is a state no real attach produces.
 */
async function seedAttachedUpload(
  userId: string,
  agentId: string,
  messageId: string,
  opts: { filename?: string; mimeType?: string; buffer?: Buffer; writeFile?: boolean } = {}
) {
  const filename = opts.filename ?? "test.png";
  const buffer = opts.buffer ?? PNG;
  const row = await seedStagedUpload(userId, agentId, {
    filename,
    mimeType: opts.mimeType,
    buffer,
    status: "attached",
    expiresAt: null,
    messageId,
  });

  if (opts.writeFile !== false) {
    const uploadsDir = join(tmpRoot, agentId, "uploads");
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, filename), buffer);
  }

  return row;
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe("materializeAttachments", () => {
  it("returns empty result for empty attachmentIds", async () => {
    const { materializeAttachments } = await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const result = await materializeAttachments({
      agentId: agent.id,
      userId: user.id,
      attachmentIds: [],
      messageId: "msg-1",
      agentName: agent.name,
    });
    expect(result.chatAttachments).toEqual([]);
    expect(result.workspaceRefs).toEqual([]);
  });

  it("promotes staged files to attached and returns chatAttachments + workspaceRefs", async () => {
    const { materializeAttachments } = await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const row = await seedStagedUpload(user.id, agent.id, {
      filename: "photo.png",
      mimeType: "image/png",
      buffer: PNG,
    });

    const result = await materializeAttachments({
      agentId: agent.id,
      userId: user.id,
      attachmentIds: [row.id],
      messageId: "msg-001",
      agentName: agent.name,
    });

    // Image MIME → chatAttachments has one entry
    expect(result.chatAttachments).toHaveLength(1);
    expect(result.chatAttachments[0].mimeType).toBe("image/png");
    expect(result.chatAttachments[0].fileName).toBe("photo.png");
    expect(typeof result.chatAttachments[0].content).toBe("string");

    // workspaceRefs has one entry
    expect(result.workspaceRefs).toHaveLength(1);
    expect(result.workspaceRefs[0].relativePath).toBe("uploads/photo.png");
    expect(result.workspaceRefs[0].absolutePath).toBe(`${tmpRoot}/${agent.id}/uploads/photo.png`);
    expect(result.workspaceRefs[0].mimeType).toBe("image/png");

    // DB row flipped to attached
    const [updated] = await db.select().from(uploadedFiles).where(eq(uploadedFiles.id, row.id));
    expect(updated.status).toBe("attached");
    expect(updated.messageId).toBe("msg-001");
    expect(updated.attachedAt).not.toBeNull();
    expect(updated.expiresAt).toBeNull();
  });

  it("populates workspaceRefs but not chatAttachments for PDF MIME", async () => {
    const { materializeAttachments } = await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const row = await seedStagedUpload(user.id, agent.id, {
      filename: "doc.pdf",
      mimeType: "application/pdf",
      buffer: PDF,
    });

    const result = await materializeAttachments({
      agentId: agent.id,
      userId: user.id,
      attachmentIds: [row.id],
      messageId: "msg-002",
      agentName: agent.name,
    });

    expect(result.chatAttachments).toHaveLength(0);
    expect(result.workspaceRefs).toHaveLength(1);
    expect(result.workspaceRefs[0].relativePath).toBe("uploads/doc.pdf");
  });

  it("throws AttachmentNotFoundError and emits audit failure for cross-user id", async () => {
    const { materializeAttachments, AttachmentNotFoundError } =
      await import("@/server/attachment-pipeline");

    const owner = await seedUser({ email: "owner@example.com" });
    const attacker = await seedUser({ email: "attacker@example.com" });
    const agent = await seedAgent(owner.id);

    const row = await seedStagedUpload(owner.id, agent.id);

    await expect(
      materializeAttachments({
        agentId: agent.id,
        userId: attacker.id, // wrong user
        attachmentIds: [row.id],
        messageId: "msg-evil",
        agentName: agent.name,
      })
    ).rejects.toBeInstanceOf(AttachmentNotFoundError);

    // Audit failure recorded
    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "file.upload.attached"));
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("failure");
    const detail = entries[0].detail as Record<string, unknown>;
    expect(detail.reason).toBe("not_found");
    expect(detail.uploadId).toBe(row.id);
  });

  it("throws AttachmentExpiredError and emits audit failure for expired row", async () => {
    const { materializeAttachments, AttachmentExpiredError } =
      await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const row = await seedStagedUpload(user.id, agent.id, {
      expiresAt: new Date(Date.now() - 1000), // already expired
    });

    await expect(
      materializeAttachments({
        agentId: agent.id,
        userId: user.id,
        attachmentIds: [row.id],
        messageId: "msg-expired",
        agentName: agent.name,
      })
    ).rejects.toBeInstanceOf(AttachmentExpiredError);

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "file.upload.attached"));
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("failure");
    const detail = entries[0].detail as Record<string, unknown>;
    expect(detail.reason).toBe("expired");
    expect(detail.uploadId).toBe(row.id);
  });

  it("throws AttachmentAlreadyAttachedError and emits audit failure for already-attached row", async () => {
    const { materializeAttachments, AttachmentAlreadyAttachedError } =
      await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    // Seed as already-attached (expiresAt null is fine for attached rows)
    const row = await seedStagedUpload(user.id, agent.id, {
      status: "attached",
      expiresAt: null,
    });

    await expect(
      materializeAttachments({
        agentId: agent.id,
        userId: user.id,
        attachmentIds: [row.id],
        messageId: "msg-double",
        agentName: agent.name,
      })
    ).rejects.toBeInstanceOf(AttachmentAlreadyAttachedError);

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "file.upload.attached"));
    expect(entries).toHaveLength(1);
    expect(entries[0].outcome).toBe("failure");
    const detail = entries[0].detail as Record<string, unknown>;
    expect(detail.reason).toBe("already_attached");
    expect(detail.uploadId).toBe(row.id);
  });

  // #1195. A retry re-sends the message it retries, attachment ids and all, so
  // the rows it names are already `attached` from the first attempt. Treating
  // that as the "you cannot reuse an upload" error would reject the retry
  // outright, which is worse than the bug it replaced.
  //
  // Note the correlation is `isRetry`, NOT the message id: client-router mints
  // a fresh `messageId` per frame (`crypto.randomUUID()`), so a retry never
  // carries the id its first attempt was stored under. Keying on messageId
  // equality looks right and matches nothing in production.
  it("re-references a retry's already-attached uploads instead of refusing them", async () => {
    const { materializeAttachments } = await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const row = await seedAttachedUpload(user.id, agent.id, "msg-first-attempt");

    const result = await materializeAttachments({
      agentId: agent.id,
      userId: user.id,
      attachmentIds: [row.id],
      messageId: "msg-a-different-id-than-the-first-attempt",
      agentName: agent.name,
      isRetry: true,
    });

    // The workspace ref the agent is handed must be the durable uploads/ path,
    // identical to the one the first attempt produced.
    expect(result.workspaceRefs).toHaveLength(1);
    expect(result.workspaceRefs[0].relativePath).toBe("uploads/test.png");
    expect(result.workspaceRefs[0].absolutePath).toMatch(/\/uploads\/test\.png$/);
    // Vision has to keep working on a retry too, so an image is re-encoded.
    expect(result.chatAttachments).toHaveLength(1);
    expect(result.chatAttachments[0].fileName).toBe("test.png");
    expect(result.chatAttachments[0].content.length).toBeGreaterThan(0);
  });

  it("refuses to hand back a ref when the retried message's file is gone from uploads/", async () => {
    // The ref is rebuilt from the row rather than read back from a column, so
    // the one thing this must never do is emit a path that resolves to
    // nothing: the agent would be told to read a file that is not there and
    // would report the attachment as unreadable. Fail loud instead.
    const { materializeAttachments, AttachmentAlreadyAttachedError } =
      await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const row = await seedAttachedUpload(user.id, agent.id, "msg-first-attempt", {
      writeFile: false,
    });

    // Assert on the REASON, not just that something threw: before the retry
    // path existed this rejected with AttachmentAlreadyAttachedError, so a bare
    // `.rejects.toThrow()` here would have passed against the old code and
    // proved nothing about the missing file.
    const err = await materializeAttachments({
      agentId: agent.id,
      userId: user.id,
      attachmentIds: [row.id],
      messageId: "msg-retry",
      agentName: agent.name,
      isRetry: true,
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(AttachmentAlreadyAttachedError);
    expect((err as Error).message).toMatch(/uploads\/test\.png/);
  });

  it("still refuses an already-attached upload on an ordinary send", async () => {
    // The negative control for the test above, on the SAME fixture: the only
    // difference is `isRetry`. Without it, re-referencing an attached upload
    // stays an error — otherwise the guard would be gone rather than gated.
    const { materializeAttachments, AttachmentAlreadyAttachedError } =
      await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const row = await seedAttachedUpload(user.id, agent.id, "msg-first-attempt");

    await expect(
      materializeAttachments({
        agentId: agent.id,
        userId: user.id,
        attachmentIds: [row.id],
        messageId: "msg-fresh-send",
        agentName: agent.name,
      })
    ).rejects.toBeInstanceOf(AttachmentAlreadyAttachedError);
  });

  it("base64-encodes the promoted image file in chatAttachments content", async () => {
    const { materializeAttachments } = await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const row = await seedStagedUpload(user.id, agent.id, {
      filename: "photo.png",
      mimeType: "image/png",
      buffer: PNG,
    });

    const result = await materializeAttachments({
      agentId: agent.id,
      userId: user.id,
      attachmentIds: [row.id],
      messageId: "msg-img",
      agentName: agent.name,
    });

    const content = result.chatAttachments[0].content;
    expect(Buffer.from(content, "base64")).toEqual(PNG);
  });

  it("emits file.upload.attached audit success with messageId for each promoted file", async () => {
    const { materializeAttachments } = await import("@/server/attachment-pipeline");

    const user = await seedUser();
    const agent = await seedAgent(user.id);

    const row1 = await seedStagedUpload(user.id, agent.id, {
      filename: "a.png",
      mimeType: "image/png",
      buffer: PNG,
      draftId: "draft-a",
    });
    const row2 = await seedStagedUpload(user.id, agent.id, {
      filename: "b.pdf",
      mimeType: "application/pdf",
      buffer: PDF,
      draftId: "draft-b",
    });

    await materializeAttachments({
      agentId: agent.id,
      userId: user.id,
      attachmentIds: [row1.id, row2.id],
      messageId: "msg-multi",
      agentName: agent.name,
    });

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "file.upload.attached"));

    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      expect(entry.outcome).toBe("success");
      const detail = entry.detail as Record<string, unknown>;
      expect(detail.messageId).toBe("msg-multi");
      expect(typeof detail.uploadId).toBe("string");
      expect(typeof detail.filename).toBe("string");
      const agentDetail = detail.agent as { id: string; name: string };
      expect(agentDetail.id).toBe(agent.id);
      expect(agentDetail.name).toBe(agent.name);
    }
  });
});
