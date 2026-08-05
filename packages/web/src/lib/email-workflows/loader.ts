import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, emailWorkflows, emailWorkflowConnections } from "@/db/schema";
import type { WorkflowForDispatch } from "@/lib/email-workflows/dispatch";

/**
 * One (workflow × connection) unit of work, ready to hand downstream: the
 * dispatcher's {@link WorkflowForDispatch} plus the connection's watermark. The
 * mail lister (Brick C) lists only mail newer than `sinceTs` (design §6); the
 * dispatcher then runs each listed email through filter → claim → run → notify.
 */
export interface DispatchableWorkflow {
  workflow: WorkflowForDispatch;
  /** email_workflow_connections.since_ts — the per-connection listing floor. */
  sinceTs: Date;
  /** email_workflows.sweep_window_days — how far back the sweep re-lists (design §5). */
  sweepWindowDays: number;
}

/**
 * Why an enabled workflow could not be turned into a unit of work. Three
 * misconfigurations reach the same dead end and each needs a different fix —
 * hand the workflow to someone else, give the agent an owner, or point it at a
 * mailbox again — so they are reported apart rather than as one "cannot run".
 */
export type UnrunnableReason =
  "shared-agent-has-no-creator" | "personal-agent-has-no-owner" | "watches-no-mailbox";

/**
 * An enabled workflow the loader emitted no unit of work for. One entry per
 * *workflow*, not per (workflow × connection): every reason here is a property
 * of the workflow alone, so all of its rows drop together.
 */
export interface UnrunnableWorkflow {
  workflowId: string;
  agentId: string;
  /**
   * Snapshotted beside the id (AGENTS.md), because this feeds an operator-facing
   * log line that has to read sensibly for a workflow nobody is going to look up.
   */
  name: string;
  reason: UnrunnableReason;
}

/**
 * What one load produced: the dispatchable units, and the enabled workflows that
 * yielded none. The second half exists because dropping a workflow that cannot
 * run is correct but dropping it *silently* is not — see
 * {@link loadDispatchableWorkflows}.
 */
export interface WorkflowLoadResult {
  units: DispatchableWorkflow[];
  unrunnable: UnrunnableWorkflow[];
}

/**
 * Load every *enabled* email workflow, fanned out to one unit of work per
 * attached connection with its notification recipients resolved. This is the
 * missing link between the DB and the already-complete `dispatchEmails`: it
 * builds the `WorkflowForDispatch` values the dispatcher consumes but nobody
 * else produces. Both the normal poll and the reconciliation sweep start here.
 *
 * `enabled` is the **sole** dispatch gate (the partial index
 * `email_workflows_enabled_idx` exists for exactly this query). `status`
 * (`pending | active | error`) is deliberately NOT filtered: it is a health
 * signal the dispatcher *writes*, not a gate it *reads*. Gating on it would let
 * one failed run wedge an `enabled` workflow off forever (nothing resets it to
 * `active`), and would strand freshly-created `pending` workflows — both break
 * the at-least-once resilience the ledger + reconciliation sweep are built on.
 *
 * Recipients follow the scope model (design §7): a **personal** agent's workflow
 * notifies its owner; a **shared** agent's workflow notifies its creator. A
 * workflow whose recipient can't be resolved (e.g. a shared workflow with no
 * recorded creator, or a personal agent with no owner) is dropped rather than
 * emitted — `dispatchEmails` rejects an empty recipient set, so an
 * undeliverable unit of work must never reach it.
 *
 * Every such workflow is **reported** as well as dropped, in `unrunnable`. The
 * row stays `enabled: true` and the Automations UI keeps showing it that way, so
 * a bare `continue` here is a workflow that has quietly stopped running with
 * nothing anywhere saying so. The sweep turns this report into the workflow's
 * `error` status, which is what an operator actually sees.
 *
 * Two of the three reasons are reachable through an ordinary admin action, and
 * neither used to leave a trace (the third, a personal agent without an owner,
 * is a shape the app never produces):
 * - `email_workflows.created_by` is `ON DELETE SET NULL` (#1097), so erasing a
 *   user orphans the workflows they created on shared agents. Before that FK
 *   change the DELETE would have failed loudly instead.
 * - `DELETE /api/integrations/:connectionId` hard-deletes a connection and
 *   cascades `email_workflow_connections`, so disconnecting a mailbox can leave
 *   an enabled workflow watching nothing.
 *
 * The second is why the connection join is a LEFT join. An inner join drops a
 * workflow with no connections before this function can see it at all — not in
 * `units`, not in `unrunnable`, and therefore not in the set of ids the sweep
 * writes `status` for, so it went on displaying `active` while doing nothing.
 */
export async function loadDispatchableWorkflows(): Promise<WorkflowLoadResult> {
  const rows = await db
    .select({
      workflowId: emailWorkflows.id,
      agentId: emailWorkflows.agentId,
      name: emailWorkflows.name,
      filter: emailWorkflows.filter,
      action: emailWorkflows.action,
      sweepWindowDays: emailWorkflows.sweepWindowDays,
      createdBy: emailWorkflows.createdBy,
      isPersonal: agents.isPersonal,
      ownerId: agents.ownerId,
      connectionId: emailWorkflowConnections.connectionId,
      sinceTs: emailWorkflowConnections.sinceTs,
    })
    .from(emailWorkflows)
    .innerJoin(agents, eq(agents.id, emailWorkflows.agentId))
    .leftJoin(emailWorkflowConnections, eq(emailWorkflowConnections.workflowId, emailWorkflows.id))
    .where(eq(emailWorkflows.enabled, true));

  const units: DispatchableWorkflow[] = [];
  // Keyed by workflow id: every reason is a property of the workflow, so it
  // holds on all of its connection rows, and the sweep writes one `status` per
  // workflow — report it once rather than once per mailbox.
  const unrunnable = new Map<string, UnrunnableWorkflow>();
  const report = (row: (typeof rows)[number], reason: UnrunnableReason) => {
    unrunnable.set(row.workflowId, {
      workflowId: row.workflowId,
      agentId: row.agentId,
      name: row.name,
      reason,
    });
  };
  for (const row of rows) {
    // The LEFT join's unmatched row: an enabled workflow with no connections at
    // all. Checked first because it is the row-shape question — the recipient
    // is moot for a workflow with nothing to read. A workflow that has lost both
    // its mailboxes and its recipient reports only this one; the operator hits
    // the other on the next pass, once this is fixed.
    if (row.connectionId === null || row.sinceTs === null) {
      report(row, "watches-no-mailbox");
      continue;
    }
    const recipientUserIds = resolveRecipients(row);
    if (recipientUserIds.length === 0) {
      report(row, row.isPersonal ? "personal-agent-has-no-owner" : "shared-agent-has-no-creator");
      continue;
    }
    units.push({
      workflow: {
        id: row.workflowId,
        agentId: row.agentId,
        connectionId: row.connectionId,
        name: row.name,
        filter: row.filter,
        action: row.action,
        recipientUserIds,
      },
      sinceTs: row.sinceTs,
      sweepWindowDays: row.sweepWindowDays,
    });
  }
  return { units, unrunnable: [...unrunnable.values()] };
}

/**
 * Scope model (design §7): a personal agent's workflow notifies its owner; a
 * shared agent's workflow notifies its creator. Returns `[]` when no recipient
 * can be resolved, which the caller drops and reports as unrunnable.
 */
function resolveRecipients(row: {
  isPersonal: boolean;
  ownerId: string | null;
  createdBy: string | null;
}): string[] {
  const recipient = row.isPersonal ? row.ownerId : row.createdBy;
  return recipient ? [recipient] : [];
}
