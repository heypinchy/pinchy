import { NextResponse } from "next/server";

import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { grantedDataPaths } from "@/lib/agent-granted-paths";
import { type AgentPluginConfig } from "@/db/schema";
import { DEFAULT_ORG_ID } from "@/lib/knowledge/constants";
import { getKnowledgeFolderStatus } from "@/lib/knowledge/index-status";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/knowledge/folders — which of the agent's folders
 * are searchable, being indexed, queued, or incomplete (#1386).
 *
 * Open to everyone who can chat with the agent, not only admins: "why doesn't
 * it know about X?" is a member's question first. The agent gate is the one
 * the chat itself goes through, so a member who cannot open the agent gets a
 * 404 here too.
 *
 * Scope: the agent's SAVED `pinchy-files` grants, never the request — the
 * same allow-list retrieval searches.
 */
// audit-exempt: read-only status of the agent's granted folders, their subfolders and its latest run, for people who can already chat with the agent; it changes nothing.
export const GET = withAuth<RouteContext>(async (_request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const allowedPaths = grantedDataPaths(agentOrError.pluginConfig as AgentPluginConfig | null);

  return NextResponse.json(await getKnowledgeFolderStatus(DEFAULT_ORG_ID, agentId, allowedPaths));
});
