import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { agents, agentConnectionPermissions, integrationConnections } from "@/db/schema";
import { withAuth } from "@/lib/api-auth";
import { EMAIL_READ_OPERATIONS } from "@/lib/tool-registry";
import { canManageAgentWorkflows } from "@/lib/email-workflows/authz";

/**
 * GET /api/automations/connections?agentId=<id> — the mailbox choices the
 * Automations create form (#139) renders in its picker.
 *
 * The connections a workflow may point at are EXACTLY those the create route
 * (POST /api/automations) accepts: the ones the agent is permitted to READ
 * (agent_connection_permissions, model="email", operation ∈
 * EMAIL_READ_OPERATIONS). A workflow's trigger lists and reads mail, so a
 * draft/send-only grant does not qualify. Resolving the picker through the same
 * gate keeps it from ever offering a connection the create route would reject —
 * or hiding one it accepts.
 *
 * Same scope gate as list/create (canManageAgentWorkflows): a member sees their
 * own personal agent's connections; a shared agent is admin-only.
 *
 * audit-exempt: read-only; returns nothing state-changing and writes nothing.
 */
export const GET = withAuth(async (request, _ctx, session) => {
  const agentId = new URL(request.url).searchParams.get("agentId");
  if (!agentId) {
    return NextResponse.json({ error: "agentId is required" }, { status: 400 });
  }

  const [agent] = await db
    .select({ isPersonal: agents.isPersonal, ownerId: agents.ownerId })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }
  if (!canManageAgentWorkflows(agent, { id: session.user.id!, role: session.user.role })) {
    return NextResponse.json({ error: "You do not have access to this agent" }, { status: 403 });
  }

  // selectDistinct: an agent can hold several read-operation rows (read, and the
  // legacy "search"/"list" aliases) for one connection — collapse them to one id.
  const permitted = await db
    .selectDistinct({ connectionId: agentConnectionPermissions.connectionId })
    .from(agentConnectionPermissions)
    .where(
      and(
        eq(agentConnectionPermissions.agentId, agentId),
        eq(agentConnectionPermissions.model, "email"),
        inArray(agentConnectionPermissions.operation, [...EMAIL_READ_OPERATIONS])
      )
    );
  const ids = permitted.map((r) => r.connectionId);

  // Resolve names in one query, keyed off the already-deduped ids (a join on the
  // permission rows would repeat a connection once per read-alias operation).
  const connections = ids.length
    ? await db
        .select({ id: integrationConnections.id, name: integrationConnections.name })
        .from(integrationConnections)
        .where(inArray(integrationConnections.id, ids))
    : [];

  return NextResponse.json(connections);
});
