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
 * Why an enabled workflow could not be turned into a unit of work. The two
 * misconfigurations reach the same dead end but need different fixes — hand the
 * workflow to someone else, or give the agent an owner — so they are reported
 * apart rather than as one "no recipient".
 */
export type UndeliverableReason = "shared-agent-has-no-creator" | "personal-agent-has-no-owner";

/**
 * An enabled workflow the loader refused to emit because nobody could be
 * notified of its runs. One entry per *workflow*, not per (workflow ×
 * connection): the recipient is resolved from workflow and agent columns alone,
 * so every one of a workflow's rows drops together.
 */
export interface UndeliverableWorkflow {
  workflowId: string;
  agentId: string;
  /**
   * Snapshotted beside the id (AGENTS.md), because this feeds an operator-facing
   * log line that has to read sensibly for a workflow nobody is going to look up.
   */
  name: string;
  reason: UndeliverableReason;
}

/**
 * What one load produced: the dispatchable units, and the enabled workflows that
 * yielded none. The second half exists because dropping an undeliverable
 * workflow is correct but dropping it *silently* is not — see
 * {@link loadDispatchableWorkflows}.
 */
export interface DispatchableWorkflows {
  units: DispatchableWorkflow[];
  undeliverable: UndeliverableWorkflow[];
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
 * It is **reported** as well as dropped, in `undeliverable`. The row stays
 * `enabled: true` and the Automations UI keeps showing it that way, so a bare
 * `continue` here is a workflow that has quietly stopped running with nothing
 * anywhere saying so. `email_workflows.created_by` is `ON DELETE SET NULL`
 * (#1097), which makes exactly that state reachable by erasing a user — before
 * that FK change the DELETE would have failed loudly instead. The sweep turns
 * this report into the workflow's `error` status, which is what an operator
 * actually sees.
 */
export async function loadDispatchableWorkflows(): Promise<DispatchableWorkflows> {
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

  const units: DispatchableWorkflow[] = [];
  // Keyed by workflow id: a workflow drops on every one of its connection rows
  // (the recipient does not depend on the connection), and the sweep writes one
  // `status` per workflow — so report it once rather than once per mailbox.
  const undeliverable = new Map<string, UndeliverableWorkflow>();
  for (const row of rows) {
    const recipientUserIds = resolveRecipients(row);
    if (recipientUserIds.length === 0) {
      undeliverable.set(row.workflowId, {
        workflowId: row.workflowId,
        agentId: row.agentId,
        name: row.name,
        reason: row.isPersonal ? "personal-agent-has-no-owner" : "shared-agent-has-no-creator",
      });
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
  return { units, undeliverable: [...undeliverable.values()] };
}

/**
 * Scope model (design §7): a personal agent's workflow notifies its owner; a
 * shared agent's workflow notifies its creator. Returns `[]` when no recipient
 * can be resolved, which the caller drops and reports as undeliverable.
 */
function resolveRecipients(row: {
  isPersonal: boolean;
  ownerId: string | null;
  createdBy: string | null;
}): string[] {
  const recipient = row.isPersonal ? row.ownerId : row.createdBy;
  return recipient ? [recipient] : [];
}
