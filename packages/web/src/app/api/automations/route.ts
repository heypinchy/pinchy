import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import {
  agents,
  emailWorkflows,
  emailWorkflowConnections,
  agentConnectionPermissions,
} from "@/db/schema";
import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { createAutomationSchema } from "@/lib/schemas/automations";
import { deferAuditLog } from "@/lib/audit-deferred";

/**
 * POST /api/automations — create an Inbox Agent email workflow (design §5).
 *
 * The single write path both the Automations form (#139) and the conversational
 * create tool (#705) go through, so one schema, one RBAC gate, one audit event
 * cover every way a workflow is born ("same object, one system").
 *
 * Scope-based access (design §7, #705): a member may create a workflow on a
 * personal agent they OWN; anything touching a shared agent requires an admin.
 * "Own connections" maps to the connections the agent is actually permitted to
 * read (agent_connection_permissions) — integration_connections has no per-user
 * owner, so agent-scoped permission is the real, code-backed boundary.
 *
 * Propose, don't self-activate: the workflow is always written `pending` +
 * `disabled`. Enabling it is a separate, human-gated step in the Automations tab
 * — an agent (or a form) must never grant itself standing autonomous authority.
 */
export const POST = withAuth(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(createAutomationSchema, request);
  if ("error" in parsed) return parsed.error;
  const { agentId, name, filter, action, connectionIds, sweepWindowDays } = parsed.data;

  const userId = session.user.id!;
  const isAdmin = session.user.role === "admin";

  const [agent] = await db
    .select({
      id: agents.id,
      name: agents.name,
      isPersonal: agents.isPersonal,
      ownerId: agents.ownerId,
    })
    .from(agents)
    .where(eq(agents.id, agentId));
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // A member may act only on a personal agent they own; a shared agent (or
  // someone else's personal agent) is admin-only.
  const isOwnPersonalAgent = agent.isPersonal && agent.ownerId === userId;
  if (!isOwnPersonalAgent && !isAdmin) {
    return NextResponse.json(
      { error: "You do not have permission to create a workflow on this agent" },
      { status: 403 }
    );
  }

  // Every requested mailbox must be one the agent is allowed to read. An unknown
  // connection id has no permission row either, so this single check rejects
  // both "no access" and "no such connection" — a workflow must never point at a
  // mailbox its agent can't open.
  const requestedConnectionIds = [...new Set(connectionIds)];
  const permittedRows = await db
    .selectDistinct({ connectionId: agentConnectionPermissions.connectionId })
    .from(agentConnectionPermissions)
    .where(
      and(
        eq(agentConnectionPermissions.agentId, agentId),
        eq(agentConnectionPermissions.model, "email"),
        inArray(agentConnectionPermissions.connectionId, requestedConnectionIds)
      )
    );
  const permitted = new Set(permittedRows.map((r) => r.connectionId));
  const missing = requestedConnectionIds.filter((id) => !permitted.has(id));
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `The agent has no email access to connection(s): ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  // Transactional two-table write: the workflow and its connection watermarks
  // land together or not at all. `sinceTs = now` is the per-connection floor, so
  // a fresh workflow never retroactively processes historical mail (design §8).
  const now = new Date();
  const workflow = await db.transaction(async (tx) => {
    const [wf] = await tx
      .insert(emailWorkflows)
      .values({ agentId, name, filter, action, sweepWindowDays, createdBy: userId })
      .returning();
    await tx.insert(emailWorkflowConnections).values(
      requestedConnectionIds.map((connectionId) => ({
        workflowId: wf.id,
        connectionId,
        sinceTs: now,
      }))
    );
    return wf;
  });

  // Deferred: the rows are committed and non-rollbackable, so an audit outage
  // must not fail the create. Ids only — connection names can carry addresses.
  deferAuditLog({
    actorType: "user",
    actorId: userId,
    eventType: "email_workflow.created",
    outcome: "success",
    detail: {
      workflow: { id: workflow.id, name: workflow.name },
      agent: { id: agent.id, name: agent.name },
      connectionCount: requestedConnectionIds.length,
      connectionIds: requestedConnectionIds,
      enabled: workflow.enabled,
      status: workflow.status,
    },
  });

  return NextResponse.json(
    { id: workflow.id, name: workflow.name, enabled: workflow.enabled, status: workflow.status },
    { status: 201 }
  );
});
