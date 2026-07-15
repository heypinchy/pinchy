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
 */
export async function loadDispatchableWorkflows(): Promise<DispatchableWorkflow[]> {
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
    .innerJoin(emailWorkflowConnections, eq(emailWorkflowConnections.workflowId, emailWorkflows.id))
    .where(eq(emailWorkflows.enabled, true));

  const result: DispatchableWorkflow[] = [];
  for (const row of rows) {
    const recipientUserIds = resolveRecipients(row);
    if (recipientUserIds.length === 0) continue;
    result.push({
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
  return result;
}

/**
 * Scope model (design §7): a personal agent's workflow notifies its owner; a
 * shared agent's workflow notifies its creator. Returns `[]` when no recipient
 * can be resolved, which the caller drops.
 */
function resolveRecipients(row: {
  isPersonal: boolean;
  ownerId: string | null;
  createdBy: string | null;
}): string[] {
  const recipient = row.isPersonal ? row.ownerId : row.createdBy;
  return recipient ? [recipient] : [];
}
