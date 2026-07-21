// audit-exempt: read-only download, no state change (see AGENTS.md § audit
// rules). Access is still gated — the GET enforces per-user ownership via an
// uploadedFiles lookup to prevent IDOR on shared agents (see below).
import { NextResponse } from "next/server";
import { join, resolve, sep } from "path";
import { and, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getWorkspacePath } from "@/lib/workspace";
import { db } from "@/db";
import { uploadedFiles } from "@/db/schema";
import { sanitizeFilename } from "@/lib/upload-validation";
import { streamWorkspaceFile } from "@/lib/serve-workspace-file";

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

  // Uploads are capped at 15 MB at upload time, so the helper's in-memory read
  // is fine. It also refuses anything outside the MIME allowlist (a sneaked-in
  // .exe must never reach the browser as application/octet-stream).
  return streamWorkspaceFile(fullPath, safeName);
});
