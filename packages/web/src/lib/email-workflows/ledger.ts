import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { processedEmails } from "@/db/schema";
import type { ProcessedEmailOutcome } from "@/lib/email-workflows/types";

export interface ClaimInput {
  workflowId: string;
  connectionId: string;
  providerMessageId: string;
  messageIdHeader?: string;
}

/**
 * Atomically claim an email for a workflow. Returns true iff THIS caller won the
 * claim and should process the email; false if it was already claimed.
 *
 * The claim is an `INSERT ... ON CONFLICT DO NOTHING` on the unique key
 * `(workflowId, connectionId, providerMessageId)` — the same idempotency pattern
 * as `channel_messages`. This makes a cursor-loss resync safe: the reconciliation
 * sweep re-discovers the email, but the ledger rejects the re-claim, so it is
 * never processed twice. The dedup decision is deterministic code, never the LLM.
 */
export async function claimEmail(input: ClaimInput): Promise<boolean> {
  const rows = await db
    .insert(processedEmails)
    .values({
      workflowId: input.workflowId,
      connectionId: input.connectionId,
      providerMessageId: input.providerMessageId,
      messageIdHeader: input.messageIdHeader ?? null,
      status: "processing",
    })
    .onConflictDoNothing({
      target: [
        processedEmails.workflowId,
        processedEmails.connectionId,
        processedEmails.providerMessageId,
      ],
    })
    .returning({ id: processedEmails.id });
  return rows.length > 0;
}

export type FinalizeStatus = "done" | "no_action" | "failed";

export interface FinalizeInput {
  workflowId: string;
  connectionId: string;
  providerMessageId: string;
  status: FinalizeStatus;
  outcome?: ProcessedEmailOutcome;
  runId?: string;
}

/**
 * Mark a claimed email's ledger row with its terminal status and outcome. Called
 * by the isolated agent run when it finishes (draft created / nothing to do /
 * failed). Keyed by the same claim tuple as {@link claimEmail}.
 *
 * Throws if no row matched: finalize is only ever valid after a successful claim,
 * so a zero-row update means a bug (finalize-before-claim or a mismatched key).
 * We surface it loudly rather than leaving the row silently stuck in `processing`.
 */
export async function finalizeEmail(input: FinalizeInput): Promise<void> {
  const rows = await db
    .update(processedEmails)
    .set({
      status: input.status,
      outcome: input.outcome ?? null,
      runId: input.runId ?? null,
      finalizedAt: new Date(),
    })
    .where(
      and(
        eq(processedEmails.workflowId, input.workflowId),
        eq(processedEmails.connectionId, input.connectionId),
        eq(processedEmails.providerMessageId, input.providerMessageId)
      )
    )
    .returning({ id: processedEmails.id });
  if (rows.length === 0) {
    throw new Error(
      `finalizeEmail: no ledger row for (${input.workflowId}, ${input.connectionId}, ${input.providerMessageId}) — finalize called without a prior claim?`
    );
  }
}
