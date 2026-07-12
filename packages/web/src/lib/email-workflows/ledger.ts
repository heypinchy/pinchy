import { db } from "@/db";
import { processedEmails } from "@/db/schema";

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
