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
  // sanitizeFilename already rejects "/" and ".."). streamWorkspaceFile opens
  // the path directly and returns 404 when it doesn't exist — so we serve the
  // first zone that yields a non-404 (no check-then-open TOCTOU). Found in
  // none => 404.
  const workspace = getWorkspacePath(agentId);
  for (const zone of DELIVERY_ZONES) {
    const zoneDir = join(workspace, zone);
    const fullPath = resolve(zoneDir, safeName);
    if (!fullPath.startsWith(resolve(zoneDir) + sep)) continue;
    const res = await streamWorkspaceFile(fullPath, safeName);
    if (res.status !== 404) return res;
  }

  return new NextResponse("Not found", { status: 404 });
});
