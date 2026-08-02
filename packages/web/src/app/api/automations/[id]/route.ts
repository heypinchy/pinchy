import { NextResponse } from "next/server";
import { and, eq, inArray } from "drizzle-orm";

import { db } from "@/db";
import { agents, emailWorkflows, emailWorkflowConnections } from "@/db/schema";
import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { updateAutomationSchema, editAutomationSchema } from "@/lib/schemas/automations";
import { scrubEmails } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { canManageAgentWorkflows } from "@/lib/email-workflows/authz";
import { findUnreadableConnectionIds } from "@/lib/email-workflows/connection-access";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * Order-independent JSON serialization for comparing two filter objects: the
 * stored filter (jsonb, key order set by Postgres) against the freshly parsed
 * one (key order set by the request). Sorting keys makes "did the filter change"
 * a value comparison, not an accident of key order. Arrays keep their order —
 * reordering `from`/`subjectContains` is a real, intended change.
 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  // Object.entries (not keys + obj[k]) so there is no computed member access to
  // flag as an injection sink — every value comes straight from the pair.
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`)
    .join(",")}}`;
}

// email_workflows.id is a uuid column: a non-uuid path param (a typo, a probe)
// would make the query throw a cast error (500) instead of resolving to
// "nothing". Guarding here turns any malformed id into a clean 404 — it
// definitionally matches no workflow.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
  if (!UUID_RE.test(id)) return undefined;
  const [row] = await db
    .select({
      id: emailWorkflows.id,
      name: emailWorkflows.name,
      enabled: emailWorkflows.enabled,
      // Editable fields — the before-image the PUT diff and audit snapshot read.
      // PATCH/DELETE ignore them; carrying them costs nothing on the same row.
      filter: emailWorkflows.filter,
      action: emailWorkflows.action,
      sweepWindowDays: emailWorkflows.sweepWindowDays,
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
 * PUT /api/automations/[id] — edit a workflow's editable representation in place
 * (the Automations edit form). Replaces name / filter / action / sweepWindowDays
 * and reconciles the mailbox set. Same scope gate and same email-read connection
 * gate as create (a workflow must never point at a mailbox its agent can't read),
 * so the two write paths accept exactly the same shapes.
 *
 * Activation is deliberately untouched: `enabled`/`status` are not fields here.
 * Editing substance never implicitly flips a workflow on or off — that stays the
 * PATCH toggle's explicit, human-gated job.
 *
 * Connection reconciliation is a DIFF, not a rewrite: a mailbox kept across the
 * edit keeps its `sinceTs` watermark (rewriting it would make an enabled
 * reconciler re-list or skip mail across the gap), a newly added mailbox is
 * stamped at `now` (never retroactively sweeps history, same rule as create),
 * and a removed one is dropped.
 */
export const PUT = withAuth<RouteContext>(async (request, { params }, session) => {
  const { id } = await params;
  const parsed = await parseRequestBody(editAutomationSchema, request);
  if ("error" in parsed) return parsed.error;
  const { name, filter, action, connectionIds, sweepWindowDays } = parsed.data;

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

  const requestedConnectionIds = [...new Set(connectionIds)];
  const missing = await findUnreadableConnectionIds(workflow.agentId, requestedConnectionIds);
  if (missing.length > 0) {
    return NextResponse.json(
      { error: `The agent has no email access to connection(s): ${missing.join(", ")}` },
      { status: 400 }
    );
  }

  const currentConnRows = await db
    .select({ connectionId: emailWorkflowConnections.connectionId })
    .from(emailWorkflowConnections)
    .where(eq(emailWorkflowConnections.workflowId, id));
  const currentConnIds = currentConnRows.map((r) => r.connectionId);
  const afterSet = new Set(requestedConnectionIds);
  const beforeSet = new Set(currentConnIds);
  const toAdd = requestedConnectionIds.filter((c) => !beforeSet.has(c));
  const toRemove = currentConnIds.filter((c) => !afterSet.has(c));

  // Field-level diff so a reviewer sees WHAT changed, not merely that it did
  // (AGENTS.md). `changedFields` is the complete, PII-safe list of what moved;
  // `changes` carries the before/after only for the fields that are safe to
  // print — the name (scrubbed) and the sweep window. `action` and `filter` can
  // carry email addresses, so they are named in `changedFields` but never dumped
  // into the append-only, HMAC-signed log. Connection membership is logged as an
  // added/removed id diff (AGENTS.md: log the diff, not the final count).
  const changedFields: string[] = [];
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (workflow.name !== name) {
    changedFields.push("name");
    changes.name = { from: scrubEmails(workflow.name), to: scrubEmails(name) };
  }
  if (workflow.action !== action) changedFields.push("action");
  if (stableStringify(workflow.filter) !== stableStringify(filter)) changedFields.push("filter");
  if (workflow.sweepWindowDays !== sweepWindowDays) {
    changedFields.push("sweepWindowDays");
    changes.sweepWindowDays = { from: workflow.sweepWindowDays, to: sweepWindowDays };
  }
  const connectionsChanged = toAdd.length > 0 || toRemove.length > 0;
  if (connectionsChanged) changedFields.push("connections");

  // No-op edit: nothing actually differs, so nothing to write or record. Return
  // 200 (idempotent) without touching the row — mirrors the PATCH no-op, and
  // leaves every kept watermark exactly where it was.
  if (changedFields.length === 0) {
    return NextResponse.json({ id, name });
  }

  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(emailWorkflows)
      .set({ name, filter, action, sweepWindowDays, updatedAt: now })
      .where(eq(emailWorkflows.id, id));
    if (toRemove.length) {
      await tx
        .delete(emailWorkflowConnections)
        .where(
          and(
            eq(emailWorkflowConnections.workflowId, id),
            inArray(emailWorkflowConnections.connectionId, toRemove)
          )
        );
    }
    if (toAdd.length) {
      await tx
        .insert(emailWorkflowConnections)
        .values(toAdd.map((connectionId) => ({ workflowId: id, connectionId, sinceTs: now })));
    }
    // Kept connections are intentionally left untouched → watermark preserved.
  });

  deferAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "email_workflow.updated",
    resource: `email_workflow:${id}`,
    outcome: "success",
    detail: {
      workflow: { id, name: scrubEmails(name) },
      agent: { id: workflow.agentId, name: workflow.agentName },
      changedFields,
      changes,
      ...(connectionsChanged ? { connections: { added: toAdd, removed: toRemove } } : {}),
    },
  });

  return NextResponse.json({ id, name });
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
