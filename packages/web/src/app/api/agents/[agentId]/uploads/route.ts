import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getWorkspacePath } from "@/lib/workspace";
import { sanitizeFilename, validateUploadBuffer } from "@/lib/upload-validation";
import { persistStagedUpload } from "@/lib/uploads";
import { appendAuditLog } from "@/lib/audit";
import { draftIdSchema } from "@/lib/schemas/uploads";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";

const MAX_BYTES = 15 * 1024 * 1024;
const STAGED_TTL_MS = 24 * 60 * 60 * 1000;

type Params = { params: Promise<{ agentId: string }> };

export const POST = withAuth<Params>(async (req, { params }, session) => {
  const { agentId } = await params;

  // Access check — same gate as the chat itself.
  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  // Validate x-pinchy-draft-id header.
  const rawDraftId = req.headers.get("x-pinchy-draft-id");
  const parsedDraftId = draftIdSchema.safeParse(rawDraftId);
  if (!parsedDraftId.success) {
    return NextResponse.json(
      { error: "Missing or invalid x-pinchy-draft-id header (must be a UUID)" },
      { status: 400 }
    );
  }
  const draftId = parsedDraftId.data;

  // Parse multipart form data.
  let formData: FormData;
  try {
    formData = await req.formData();
  } catch {
    return NextResponse.json({ error: "Failed to parse multipart form data" }, { status: 400 });
  }

  const fileField = formData.get("file");
  if (!fileField || !(fileField instanceof File)) {
    return NextResponse.json({ error: "Missing file field in form data" }, { status: 400 });
  }
  const file = fileField;

  const auditBase = {
    actorType: "user" as const,
    actorId: session.user.id!,
    eventType: "file.upload.staged" as const,
    resource: `agent:${agentId}`,
  };

  // Size check before reading buffer to save memory.
  if (file.size > MAX_BYTES) {
    await appendAuditLog({
      ...auditBase,
      detail: {
        filename: file.name,
        claimedMime: file.type,
        reason: "oversize",
        agent: { id: agentId, name: agent.name },
      },
      outcome: "failure",
    });
    return NextResponse.json({ error: "File exceeds maximum size of 15 MB" }, { status: 413 });
  }

  // Decode to buffer.
  const buffer = Buffer.from(await file.arrayBuffer());

  // Sanitize filename.
  let safeName: string;
  try {
    safeName = sanitizeFilename(file.name);
  } catch (err) {
    await appendAuditLog({
      ...auditBase,
      detail: {
        filename: file.name,
        claimedMime: file.type,
        reason: "filename",
        agent: { id: agentId, name: agent.name },
      },
      outcome: "failure",
    });
    const message = err instanceof Error ? err.message : "Invalid filename";
    return NextResponse.json({ error: message }, { status: 400 });
  }

  // MIME validation.
  let detectedMime: string;
  try {
    detectedMime = await validateUploadBuffer(buffer, file.type);
  } catch (err) {
    await appendAuditLog({
      ...auditBase,
      detail: {
        filename: safeName,
        claimedMime: file.type,
        reason: "mime",
        agent: { id: agentId, name: agent.name },
      },
      outcome: "failure",
    });
    const message = err instanceof Error ? err.message : "Unsupported file type";
    return NextResponse.json({ error: message }, { status: 415 });
  }

  // Persist to staging.
  const workspaceRoot = getWorkspacePath(agentId);
  const staged = await persistStagedUpload({ workspaceRoot, filename: safeName, buffer });

  // If the DB insert below throws, the staged file is left on disk without a DB row.
  // The GC sweep (upload-gc.ts) only removes rows that exist in the DB — a file
  // without a row is technically unreachable by GC. In practice: disk is cheap and
  // FS orphans from this race are small. A future hardening task can add cleanup here.

  // DB insert.
  const now = new Date();
  const expiresAt = new Date(now.getTime() + STAGED_TTL_MS);
  const [row] = await db
    .insert(uploadedFiles)
    .values({
      userId: session.user.id!,
      agentId,
      draftId,
      filename: safeName,
      mimeType: detectedMime,
      sizeBytes: buffer.length,
      contentHash: staged.contentHash,
      status: "staged",
      stagingPath: staged.relativePath,
      expiresAt,
    })
    .returning();

  // Emit success audit.
  await appendAuditLog({
    ...auditBase,
    detail: {
      uploadId: row.id,
      filename: safeName,
      mimeType: detectedMime,
      sizeBytes: buffer.length,
      contentHash: staged.contentHash,
      agent: { id: agentId, name: agent.name },
    },
    outcome: "success",
  });

  return NextResponse.json(
    { id: row.id, filename: safeName, mimeType: detectedMime, sizeBytes: buffer.length },
    { status: 201 }
  );
});
