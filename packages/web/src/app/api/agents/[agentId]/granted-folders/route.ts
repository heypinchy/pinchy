import { NextResponse } from "next/server";

import { withAdmin } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { type AgentPluginConfig } from "@/db/schema";
import { grantedDataPaths } from "@/lib/agent-granted-paths";
import { checkGrantedFolders } from "@/lib/granted-folder-status";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/granted-folders — whether each folder the agent is
 * granted still exists, so the picker can mark a grant whose folder was
 * renamed, moved or deleted instead of showing it as an ordinary ticked box
 * (#1363).
 *
 * Scope: the agent's SAVED `pinchy-files` grants under /data, nothing else.
 * The route reads no path from the request, so it cannot be used to ask
 * whether an arbitrary folder exists.
 *
 * Admin-only (`withAdmin`), like browsing subfolders: saving grants is itself
 * an admin action, and opening this to members would let them probe which
 * folders under /data exist. Access-gated like every agent read — another user's
 * personal agent answers 404.
 */
// audit-exempt: read-only file-system check of already-saved grants, no state change.
export const GET = withAdmin<RouteContext>(async (_request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  const folders = await checkGrantedFolders(
    grantedDataPaths(agentOrError.pluginConfig as AgentPluginConfig | null)
  );
  return NextResponse.json({ folders });
});
