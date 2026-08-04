// audit-exempt: read-only download, no state change (see AGENTS.md § audit
// rules). Access is still gated — the GET enforces per-user authorization via an
// agent_delivered_files grant lookup to prevent IDOR on shared agents, exactly
// like the sibling uploads route. The delivery WRITE (which creates the grant)
// is audited where it happens, in client-router.
import { NextResponse } from "next/server";
import { join, resolve, sep } from "path";
import { and, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getWorkspacePath } from "@/lib/workspace";
import { db } from "@/db";
import { agentDeliveredFiles } from "@/db/schema";
import { sanitizeFilename } from "@/lib/upload-validation";
import { streamWorkspaceFile } from "@/lib/serve-workspace-file";
import { realpathWithinDir } from "@/lib/agent-file-access";

type Params = { params: Promise<{ agentId: string; filename: string }> };

// The workspace subdirectories a delivery can live in. The grant no longer
// records which one — agent-generated files land in `workbench`, agent-fetched
// files (e.g. an email attachment) in `uploads` — so the serving route searches
// both, in order, and serves the first zone the file actually exists in.
const DELIVERY_ZONES = ["workbench", "uploads"] as const;

export const GET = withAuth<Params>(async (_req, { params }, session) => {
  const { agentId, filename: rawFilename } = await params;

  // Access check FIRST — same gate as the chat itself. The helper returns
  // either the agent record or a NextResponse (401/403/404) which we forward
  // verbatim to keep the leak surface identical across all agent routes.
  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  // sanitizeFilename throws on traversal attempts, control chars, empty names,
  // etc. Anything it rejects becomes a 404 — we never disclose WHY the path was
  // bad, just that the file isn't there.
  let safeName: string;
  try {
    safeName = sanitizeFilename(rawFilename);
  } catch {
    return new NextResponse("Not found", { status: 404 });
  }

  // Per-user authorization. Agent access alone is NOT sufficient: a shared
  // agent's workspace co-mingles every member's delivered files, so agent read
  // access would otherwise let user B fetch user A's file by its predictable
  // filename (IDOR). Require a delivery grant owned by the caller. 404 (not 403)
  // so non-grantees can't even confirm the file exists.
  const grants = await db
    .select({ id: agentDeliveredFiles.id })
    .from(agentDeliveredFiles)
    .where(
      and(
        eq(agentDeliveredFiles.agentId, agentId),
        eq(agentDeliveredFiles.filename, safeName),
        eq(agentDeliveredFiles.userId, session.user.id!)
      )
    );
  if (grants.length === 0) {
    return new NextResponse("Not found", { status: 404 });
  }

  // The grant authorizes the file but no longer says which zone it lives in.
  // Try each known zone in order; for each, re-resolve the final path and verify
  // it stays inside <workspace>/<zone> (defence in depth, even though
  // sanitizeFilename already rejects "/" and ".."). streamWorkspaceFile returns
  // 404 when the file isn't there, so we serve the first zone that yields a
  // non-404. Found in none => 404.
  const workspace = getWorkspacePath(agentId);
  for (const zone of DELIVERY_ZONES) {
    const zoneDir = join(workspace, zone);
    const fullPath = resolve(zoneDir, safeName);
    if (!fullPath.startsWith(resolve(zoneDir) + sep)) continue;

    // Real-path containment: the lexical check above only sees the requested
    // path itself, never what a symlink at that path points at. Resolve
    // symlinks on both sides and re-check containment — see
    // agent-file-access.ts's realpathWithinDir. A symlink resolving outside
    // this zone is treated the same as "not in this zone" (continue to the
    // next), matching the lexical-miss branch above. Note this is per ZONE,
    // not per workspace: a symlink in workbench pointing into uploads is
    // refused here and then found on the uploads pass, or not at all.
    //
    // This is a check before an open, which is why what gets opened is the
    // RESOLVED path and never `fullPath` again: re-pointing the symlink after
    // this line changes nothing, because nothing reads that path a second
    // time. The window that does remain — replacing the resolved, in-zone
    // file itself between these two lines — needs the same write access the
    // symlink did and is strictly narrower than the unchecked read this
    // replaces.
    const realPath = await realpathWithinDir(fullPath, zoneDir);
    if (!realPath) continue;

    const res = await streamWorkspaceFile(realPath, safeName);
    if (res.status !== 404) return res;
  }

  return new NextResponse("Not found", { status: 404 });
});
