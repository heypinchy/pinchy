// audit-exempt: read-only access to the caller's own uploaded attachments —
// no state change, audit log not required (see AGENTS.md § audit rules).
import { NextResponse } from "next/server";
import { open, stat } from "fs/promises";
import { join, resolve, sep, extname } from "path";
import { fileTypeFromBuffer } from "file-type";
import { and, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getWorkspacePath } from "@/lib/workspace";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import {
  sanitizeFilename,
  ALLOWED_ATTACHMENT_MIMES,
  ALLOWED_TEXT_MIMES,
} from "@/lib/upload-validation";
import { EXTENSION_TO_MIME } from "@/lib/attachment-mime";

type Params = { params: Promise<{ agentId: string; filename: string }> };

export const GET = withAuth<Params>(async (_req, { params }, session) => {
  const { agentId, filename: rawFilename } = await params;

  // Access check FIRST — same gate as the chat itself. The helper returns
  // either the agent record or a NextResponse (401/403/404) which we forward
  // verbatim to keep the leak surface identical across all agent routes.
  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  // sanitizeFilename throws on traversal attempts, control chars, empty
  // names, etc. Anything it rejects becomes a 404 — we never disclose WHY
  // the path was bad, just that the file isn't there.
  let safeName: string;
  try {
    safeName = sanitizeFilename(rawFilename);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  // Per-user ownership check. Agent access alone is NOT sufficient: a shared
  // agent's uploads/ directory co-mingles every member's attachments, so agent
  // read access would otherwise let user B fetch user A's file by its
  // predictable filename (IDOR). Require an uploadedFiles row owned by the
  // caller. 404 (not 403) so non-owners can't even confirm the file exists.
  const owned = await db
    .select({ id: uploadedFiles.id })
    .from(uploadedFiles)
    .where(
      and(
        eq(uploadedFiles.agentId, agentId),
        eq(uploadedFiles.filename, safeName),
        eq(uploadedFiles.userId, session.user.id!)
      )
    );
  if (owned.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Defence in depth: even though sanitizeFilename rejects "/" and "..",
  // re-resolve the final path and verify it's still inside <workspace>/uploads.
  // A future helper change could introduce a regression — this guard keeps the
  // attack surface bounded.
  const uploadsDir = join(getWorkspacePath(agentId), "uploads");
  const fullPath = resolve(uploadsDir, safeName);
  if (!fullPath.startsWith(resolve(uploadsDir) + sep)) {
    return new NextResponse("Not found", { status: 404 });
  }

  let info;
  try {
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is sanitized + resolve-checked above
    info = await stat(fullPath);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }
  if (!info.isFile()) {
    return new NextResponse("Not found", { status: 404 });
  }

  // Read the buffer first — uploads are capped at 15 MB at upload time so an
  // in-memory read is fine. We detect MIME from the buffer's magic bytes using
  // fileTypeFromBuffer (same as upload-validation.ts) rather than
  // fileTypeFromFile, which uses dynamic imports that Next.js/Webpack cannot
  // statically analyse ("Cannot find module as expression is too dynamic").
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- path is sanitized + resolve-checked above
  const fh = await open(fullPath, "r");
  let buffer: Buffer;
  try {
    buffer = await fh.readFile();
  } finally {
    await fh.close();
  }

  // Refuse anything outside the upload allowlist — a sneaked-in .exe must
  // never reach the browser as application/octet-stream either.
  const detected = await fileTypeFromBuffer(
    new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength)
  );

  let servedMime: string;
  if (!detected) {
    // Text files have no magic bytes. Derive MIME from extension and verify
    // against the text allowlist. Null-byte check guards against binary
    // files renamed to .csv / .txt.
    const ext = extname(safeName).toLowerCase();
    const textMime = EXTENSION_TO_MIME[ext];
    if (!textMime || !ALLOWED_TEXT_MIMES.has(textMime) || buffer.includes(0x00)) {
      return new NextResponse("Unsupported media type", { status: 415 });
    }
    servedMime = textMime;
  } else {
    if (!ALLOWED_ATTACHMENT_MIMES.has(detected.mime)) {
      return new NextResponse("Unsupported media type", { status: 415 });
    }
    servedMime = detected.mime;
  }

  return new NextResponse(Uint8Array.from(buffer), {
    headers: {
      "content-type": servedMime,
      "content-length": String(buffer.byteLength),
      "cache-control": "private, max-age=3600",
      // Inline so the browser renders PDFs/images directly instead of
      // forcing a download. The filename is advisory.
      "content-disposition": `inline; filename="${safeName.replace(/[^\x20-\x7e]/g, "_")}"; filename*=UTF-8''${encodeURIComponent(safeName)}`,
      // Allow same-origin embeds (<embed> thumbnail in AttachmentPreview).
      // Without this override Next.js emits X-Frame-Options: DENY by default
      // which blocks the <embed> from loading the file.
      "x-frame-options": "SAMEORIGIN",
    },
  });
});
