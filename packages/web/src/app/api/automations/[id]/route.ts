import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, emailWorkflows } from "@/db/schema";
import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { updateAutomationSchema } from "@/lib/schemas/automations";
import { scrubEmails } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { canManageAgentWorkflows } from "@/lib/email-workflows/authz";

type RouteContext = { params: Promise<{ id: string }> };

// email_workflows.id is a uuid column: a non-uuid path param (a typo, a probe)
// would make the query throw a cast error (500) instead of resolving to
// "nothing". Guarding here turns any malformed id into a clean 404 — it
// definitionally matches no workflow.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Load a workflow together with the ownership fields of its agent — everything
 * the scope gate and the audit snapshot need, in one round trip. Returns
 * undefined when the id is malformed or matches nothing.
 */
async function loadWorkflowWithAgent(id: string) {
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await db
    .select({
      id: emailWorkflows.id,
      name: emailWorkflows.name,
      enabled: emailWorkflows.enabled,
      agentId: emailWorkflows.agentId,
      agentName: agents.name,
      isPersonal: agents.isPersonal,
      ownerId: agents.ownerId,
    })
    .from(emailWorkflows)
    .innerJoin(agents, eq(agents.id, emailWorkflows.agentId))
    .where(eq(emailWorkflows.id, id));
  return row;
}

/**
 * PATCH /api/automations/[id] — flip a workflow's `enabled` state. This is the
 * human-gated activation step "propose, don't self-activate" reserves for a
 * person: a created workflow sits disabled until a reviewer turns it on here.
 * Scope gate matches create (own personal agent → member; shared → admin).
 *
 * `status` is deliberately untouched — it is a health signal the dispatcher
 * writes (pending→active/error), not a field this route owns; the loader gates
 * dispatch on `enabled` alone, so the next clean sweep flips a freshly enabled
 * workflow to `active` on its own.
 */
export const PATCH = withAuth<RouteContext>(async (request, { params }, session) => {
  const { id } = await params;
  const parsed = await parseRequestBody(updateAutomationSchema, request);
  if ("error" in parsed) return parsed.error;
  const { enabled } = parsed.data;

  const workflow = await loadWorkflowWithAgent(id);
  if (!workflow) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }
  if (!canManageAgentWorkflows(workflow, { id: session.user.id!, role: session.user.role })) {
    return NextResponse.json(
      { error: "You do not have permission to change this workflow" },
      { status: 403 }
    );
  }

  // No-op toggle: nothing changed, so nothing to record. Return 200 (idempotent)
  // without an audit row — an unchanged state is not an event.
  if (workflow.enabled === enabled) {
    return NextResponse.json({ id, enabled });
  }

  await db
    .update(emailWorkflows)
    .set({ enabled, updatedAt: new Date() })
    .where(eq(emailWorkflows.id, id));

  deferAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "email_workflow.updated",
    resource: `email_workflow:${id}`,
    outcome: "success",
    detail: { changes: { enabled: { from: workflow.enabled, to: enabled } } },
  });

  return NextResponse.json({ id, enabled });
});

/**
 * DELETE /api/automations/[id] — reject/remove a workflow. The FK cascade drops
 * its connection rows and ledger entries with it. Scope gate matches create.
 */
export const DELETE = withAuth<RouteContext>(async (_request, { params }, session) => {
  const { id } = await params;

  const workflow = await loadWorkflowWithAgent(id);
  if (!workflow) {
    return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
  }
  if (!canManageAgentWorkflows(workflow, { id: session.user.id!, role: session.user.role })) {
    return NextResponse.json(
      { error: "You do not have permission to delete this workflow" },
      { status: 403 }
    );
  }

  await db.delete(emailWorkflows).where(eq(emailWorkflows.id, id));

  // The row is gone, so the trail must carry its name (AGENTS.md: include
  // resource names in delete events). Scrubbed — a free-text name can hold an
  // address, and the audit log is append-only + HMAC-signed.
  const safeName = scrubEmails(workflow.name);
  deferAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "email_workflow.deleted",
    resource: `email_workflow:${id}`,
    outcome: "success",
    detail: {
      name: safeName,
      workflow: { id, name: safeName },
      agent: { id: workflow.agentId, name: workflow.agentName },
    },
  });

  return NextResponse.json({ id });
});
