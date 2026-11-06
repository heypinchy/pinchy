import { NextResponse } from "next/server";

import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getFirstIndexStatus } from "@/lib/knowledge/first-index";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/knowledge/first-index — whether the agent's first
 * index is still to come, and how far it has got (#1280).
 *
 * What the agent's chat shows, so a fresh Knowledge Base agent does not
 * quietly answer "nothing found" while its documents are still being read.
 * Open to anyone who may see the agent, unlike the admin-only reindex status:
 * the member opening the chat is the one who needs it, and the answer is a
 * state and two counts — no folders, no run history, no failure detail.
 */
// Read-only, no state change — outside require-audit-log's scope (it checks
// POST/PUT/PATCH/DELETE only), so no audit call is needed here.
export const GET = withAuth<RouteContext>(async (_request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  return NextResponse.json(await getFirstIndexStatus(agentOrError));
});
