import { NextResponse } from "next/server";
import { isUuid } from "@/lib/uuid";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { agents, emailWorkflows, users } from "@/db/schema";
import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { updateAutomationSchema } from "@/lib/schemas/automations";
import { scrubEmails } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { canManageAgentWorkflows } from "@/lib/email-workflows/authz";
import {
  arePersonalAutomationsPausedFor,
  MEMBER_AUTOMATIONS_DISABLED,
} from "@/lib/instance-policy";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The one answer both routes give for a workflow the caller may not have: the
 * same 404 an id that matches nothing gets.
 *
 * **This route's verdict differs from the agent-keyed Automations routes, and
 * deliberately so** (#880). There, `resolveWorkflowAgent` keeps a 403 for an
 * agent the caller can SEE but may not manage — a shared agent in their sidebar,
 * where "not found" would be false and would send them checking the id instead
 * of asking an admin. Here the resource is the WORKFLOW, and that middle state
 * does not exist: `GET /api/automations` asks this same `canManageAgentWorkflows`
 * — behind a visibility gate, so strictly more than this route asks — and nobody
 * refused here could have passed it there. Every caller who reaches this refusal
 * is therefore one who cannot enumerate the workflow at all, which is squarely
 * the oracle case of the criterion on `getAgentWithAccess`: a distinguishable
 * error is fine when the caller can already enumerate the resource, and an oracle
 * when they cannot.
 *
 * The implication runs one way only, and the gap is what this route is for. An
 * ADMIN passes the scope gate on a colleague's personal agent and is still
 * refused by `GET /api/automations`, which runs the visibility gate first — so
 * they can stop a workflow whose id they already hold without ever being able to
 * find one. Read and manage come apart exactly there, and it is not a hole in the
 * reasoning above: that case describes who gets THROUGH, never who gets this 404.
 * See `canManageAgentWorkflows` for the verdict, and
 * `__tests__/security/workflow-scope-gate-callers.test.ts` for what keeps the
 * split from spreading to a third caller.
 *
 * It costs nothing: a caller who gets this never sees the workflow in any list
 * either, so there is no state in which 403 would have told them something they
 * could act on.
 */
function workflowNotFound() {
  return NextResponse.json({ error: "Workflow not found" }, { status: 404 });
}

/**
 * Load a workflow together with the ownership fields of its agent — everything
 * the scope gate and the audit snapshot need, in one round trip. Returns
 * undefined when the id is malformed or matches nothing.
 */
async function loadWorkflowWithAgent(id: string) {
  // email_workflows.id is a uuid column: a malformed id (a typo, a probe) would
  // throw a cast error (500). It definitionally matches no workflow — a 404.
  if (!isUuid(id)) return undefined;
  const [row] = await db
    .select({
      id: emailWorkflows.id,
      name: emailWorkflows.name,
      enabled: emailWorkflows.enabled,
      agentId: emailWorkflows.agentId,
      agentName: agents.name,
      isPersonal: agents.isPersonal,
      ownerId: agents.ownerId,
      // The OWNER's role, not the caller's: an admin stopping a member's
      // runaway automation acts on a workflow the member policy still governs.
      ownerRole: users.role,
    })
    .from(emailWorkflows)
    .innerJoin(agents, eq(agents.id, emailWorkflows.agentId))
    .leftJoin(users, eq(users.id, agents.ownerId))
    .where(eq(emailWorkflows.id, id));
  return row;
}

/**
 * PATCH /api/automations/[id] — flip a workflow's `enabled` state. This is the
 * human-gated activation step "propose, don't self-activate" reserves for a
 * person: a created workflow sits disabled until a reviewer turns it on here.
 * Scope RULE matches create (own personal agent → member; shared → admin); the
 * refusal does not — see `workflowNotFound`.
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
  if (!workflow) return workflowNotFound();
  if (!canManageAgentWorkflows(workflow, { id: session.user.id!, role: session.user.role })) {
    return workflowNotFound();
  }

  // No-op toggle: nothing changed, so nothing to record. Return 200 (idempotent)
  // without an audit row — an unchanged state is not an event.
  if (workflow.enabled === enabled) {
    return NextResponse.json({ id, enabled });
  }

  // Switching OFF is always allowed — stopping is never what the policy is
  // against. Switching ON is refused while the policy pauses this agent's
  // automations, for an admin too: the loader would still skip it, so the
  // answer would be a workflow that reads "enabled" and never runs.
  if (enabled && (await arePersonalAutomationsPausedFor(workflow, workflow.ownerRole))) {
    return NextResponse.json(MEMBER_AUTOMATIONS_DISABLED, { status: 403 });
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
 * its connection rows and ledger entries with it. Scope RULE matches create; the
 * refusal does not — see `workflowNotFound`.
 */
export const DELETE = withAuth<RouteContext>(async (_request, { params }, session) => {
  const { id } = await params;

  const workflow = await loadWorkflowWithAgent(id);
  if (!workflow) return workflowNotFound();
  if (!canManageAgentWorkflows(workflow, { id: session.user.id!, role: session.user.role })) {
    return workflowNotFound();
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
