// audit-exempt: read-only access to the caller's own uploaded attachments —
// no state change, audit log not required (see AGENTS.md § audit rules).
import { NextResponse } from "next/server";
import { open, stat } from "fs/promises";
import { join, resolve, sep } from "path";
import { fileTypeFromBuffer } from "file-type";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getWorkspacePath } from "@/lib/workspace";
import { sanitizeFilename, ALLOWED_ATTACHMENT_MIMES } from "@/lib/upload-validation";

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
  if (!detected || !ALLOWED_ATTACHMENT_MIMES.has(detected.mime)) {
    return new NextResponse("Unsupported media type", { status: 415 });
  }

  return new NextResponse(buffer, {
    headers: {
      "content-type": detected.mime,
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
