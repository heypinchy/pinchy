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
  /**
   * Claimed emails whose delivery (notify) or finalize threw. Their ledger row
   * is intentionally left `processing` for the reconciliation sweep to retry —
   * see the ordering note below. Distinct from `failed`, which is a *run* that
   * threw but was itself delivered and finalized as `failed`.
   */
  deferred: number;
}

/**
 * Dispatch a connection's batch of emails through one workflow (design §6):
 * per email — filter (deterministic) → claim (atomic ledger) → isolated run →
 * notify → finalize ledger.
 *
 * **notify runs before finalize on purpose.** The ledger row only leaves
 * `processing` once its notification is durably persisted, so we get real
 * at-least-once delivery (§8): if notify or finalize throws, the row stays
 * `processing` and the reconciliation sweep (later slice) re-discovers and
 * retries it. The rejected alternative — finalize `done` first, then notify —
 * would, on a notify failure, strand a `done` row with no notification that no
 * sweep could ever find: a silent, permanent loss. At-least-once may deliver a
 * duplicate notification on a retry; that is the accepted trade against loss.
 *
 * A run that throws is itself an outcome, not a delivery failure: it finalizes
 * `failed` and still notifies (a run crash never leaves the ledger stuck in
 * `processing`). Runs are independent: one email's failure — run, delivery, or
 * finalize — never aborts the rest of the batch. A post-claim throw is caught,
 * counted as `deferred`, and logged; the loop moves on.
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
    deferred: 0,
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

    // Everything below the claim is isolated per email: a run crash, a notify
    // failure, or a finalize failure must not abort the batch. On a post-claim
    // throw the row stays `processing` (recoverable) and we move on.
    try {
      // The run itself is the one step whose failure is a normal outcome
      // (finalize `failed` + notify), not a reason to leave the row processing.
      let result: RunAgentResult | null = null;
      let runError: unknown;
      try {
        result = await runAgent({ workflow, email });
      } catch (err) {
        runError = err;
      }

      if (result) {
        await notify({
          agentId: workflow.agentId,
          title: result.title,
          content: result.content,
          status: "success",
          sourceType: "inbox",
          sourceId: ledgerId,
          recipientUserIds: workflow.recipientUserIds,
        });
        await finalizeEmail({
          ...claimKey,
          status: result.status,
          outcome: result.outcome,
          runId: result.runId,
        });
        summary.succeeded++;
      } else {
        await notify({
          agentId: workflow.agentId,
          title: `${workflow.name}: processing failed`,
          content: `Could not process "${email.subject}".`,
          status: "failure",
          errorMessage: runError instanceof Error ? runError.message : String(runError),
          sourceType: "inbox",
          sourceId: ledgerId,
          recipientUserIds: workflow.recipientUserIds,
        });
        await finalizeEmail({ ...claimKey, status: "failed" });
        summary.failed++;
      }
    } catch (err) {
      // Delivery or finalize threw after the claim. Leave the row `processing`
      // for the reconciliation sweep; never abort the batch.
      summary.deferred++;
      console.error(
        `dispatchEmails: deferred email ${email.providerMessageId} (workflow ${workflow.id}) after claim — left processing for the reconciliation sweep`,
        err
      );
    }
  }

  return summary;
}
