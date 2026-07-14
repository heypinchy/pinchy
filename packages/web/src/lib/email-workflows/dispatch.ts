import { claimEmail, finalizeEmail } from "@/lib/email-workflows/ledger";
import { matchesFilter } from "@/lib/email-workflows/match";
import { notify } from "@/lib/notifications/store";
import type {
  DispatchableEmail,
  EmailWorkflowFilter,
  ProcessedEmailOutcome,
} from "@/lib/email-workflows/types";

/**
 * A workflow as the dispatcher needs it for one connection's batch: the filter
 * to gate on, the agent that owns the run, and the resolved notification
 * recipients (scope resolution lives upstream, per design §7).
 */
export interface WorkflowForDispatch {
  /** email_workflows.id — the claim's workflow scope (FK into the ledger). */
  id: string;
  agentId: string;
  /** The mailbox this batch of emails came from. */
  connectionId: string;
  name: string;
  filter: EmailWorkflowFilter;
  /** Prose instruction handed to the run. */
  action: string;
  /** Resolved feed recipients; must be non-empty. */
  recipientUserIds: string[];
}

/** The terminal outcome of an isolated agent run (non-failure paths). */
export interface RunAgentResult {
  status: "done" | "no_action";
  outcome?: ProcessedEmailOutcome;
  runId?: string;
  /** Human-readable feed headline + body the run produced. */
  title: string;
  content: string;
}

/**
 * Runs the workflow's action against one email in an isolated context. Injected
 * so the dispatcher's lifecycle is testable without a real OpenClaw run; the
 * production adapter (spawns a run via the agent's tools/permissions) lands in a
 * later slice, gated on the OpenClaw bump.
 */
export type RunAgent = (ctx: {
  workflow: WorkflowForDispatch;
  email: DispatchableEmail;
}) => Promise<RunAgentResult>;

export interface DispatchSummary {
  skippedFilter: number;
  skippedAlreadyClaimed: number;
  claimed: number;
  succeeded: number;
  failed: number;
}

/**
 * Dispatch a connection's batch of emails through one workflow (design §6):
 * per email — filter (deterministic) → claim (atomic ledger) → isolated run →
 * finalize ledger → notify. Claimed-but-failed runs finalize as `failed` and
 * still notify, so a run crash never leaves the ledger stuck in `processing`
 * (§8 at-least-once). Runs are independent: one email's failure never aborts the
 * rest of the batch.
 *
 * A workflow with no recipients is a caller bug (a run nobody would ever see):
 * we reject it up front, before any claim, mirroring notify()'s own guard.
 */
export async function dispatchEmails(params: {
  workflow: WorkflowForDispatch;
  emails: DispatchableEmail[];
  runAgent: RunAgent;
}): Promise<DispatchSummary> {
  const { workflow, emails, runAgent } = params;
  if (workflow.recipientUserIds.length === 0) {
    throw new Error("dispatchEmails: workflow has no notification recipients");
  }

  const summary: DispatchSummary = {
    skippedFilter: 0,
    skippedAlreadyClaimed: 0,
    claimed: 0,
    succeeded: 0,
    failed: 0,
  };

  for (const email of emails) {
    if (!matchesFilter(email, workflow.filter)) {
      summary.skippedFilter++;
      continue;
    }

    const claimKey = {
      workflowId: workflow.id,
      connectionId: workflow.connectionId,
      providerMessageId: email.providerMessageId,
      messageIdHeader: email.messageIdHeader,
    };
    const ledgerId = await claimEmail(claimKey);
    if (ledgerId === null) {
      summary.skippedAlreadyClaimed++;
      continue;
    }
    summary.claimed++;

    try {
      const result = await runAgent({ workflow, email });
      await finalizeEmail({
        ...claimKey,
        status: result.status,
        outcome: result.outcome,
        runId: result.runId,
      });
      await notify({
        agentId: workflow.agentId,
        title: result.title,
        content: result.content,
        status: "success",
        sourceType: "inbox",
        sourceId: ledgerId,
        recipientUserIds: workflow.recipientUserIds,
      });
      summary.succeeded++;
    } catch (err) {
      await finalizeEmail({ ...claimKey, status: "failed" });
      await notify({
        agentId: workflow.agentId,
        title: `${workflow.name}: processing failed`,
        content: `Could not process "${email.subject}".`,
        status: "failure",
        errorMessage: err instanceof Error ? err.message : String(err),
        sourceType: "inbox",
        sourceId: ledgerId,
        recipientUserIds: workflow.recipientUserIds,
      });
      summary.failed++;
    }
  }

  return summary;
}
