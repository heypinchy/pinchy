import { and, eq, lt } from "drizzle-orm";
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
 * Atomically claim an email for a workflow. Returns the new ledger row's id iff
 * THIS caller won the claim and should process the email; null if it was already
 * claimed. The dispatcher uses the returned id as the notification's `sourceId`.
 *
 * The claim is an `INSERT ... ON CONFLICT DO NOTHING` on the unique key
 * `(workflowId, connectionId, providerMessageId)` — the same idempotency pattern
 * as `channel_messages`. This makes a cursor-loss resync safe: the reconciliation
 * sweep re-discovers the email, but the ledger rejects the re-claim, so it is
 * never processed twice. The dedup decision is deterministic code, never the LLM.
 */
export async function claimEmail(input: ClaimInput): Promise<string | null> {
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
  return rows[0]?.id ?? null;
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
 * finalize only ever transitions `processing` → terminal: the WHERE clause pins
 * `status = 'processing'`, so a zero-row update means either finalize-before-claim
 * or a duplicate finalize of an already-terminal row. Both are bugs, and both must
 * NOT silently overwrite a recorded outcome — we surface them loudly instead.
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
        eq(processedEmails.providerMessageId, input.providerMessageId),
        eq(processedEmails.status, "processing")
      )
    )
    .returning({ id: processedEmails.id });
  if (rows.length === 0) {
    throw new Error(
      `finalizeEmail: no processing ledger row for (${input.workflowId}, ${input.connectionId}, ${input.providerMessageId}) — already finalized or never claimed?`
    );
  }
}

/** The claim tuple of a reset row, enough for the sweep to re-list and audit it. */
export interface StuckClaimKey {
  workflowId: string;
  connectionId: string;
  providerMessageId: string;
}

/**
 * Un-stick claims that never reached a terminal status. A row is stuck in
 * `processing` when its run deferred (a transient not-ready gap — #717's
 * {@link RunDeferredError}) or the dispatch crashed after the claim but before
 * finalize. Left alone, such a row is a permanent gap: the ledger's unique claim
 * key blocks any re-claim, so the email is never retried.
 *
 * The fix is **delete-and-reclaim**: DELETE processing rows older than
 * `graceMs`, freeing the claim key so the reconciliation sweep's re-list re-runs
 * the email through the normal `claimEmail` path (design §8, "stuck `processing`
 * past timeout reset by reconciliation"). We delete rather than flip status
 * because `onConflictDoNothing` re-claims only when the key row is absent; a
 * never-finalized claim carries no recorded outcome, so nothing is lost.
 *
 * `graceMs` MUST exceed the run timeout so a legitimately in-flight run is never
 * reset out from under itself — at-least-once still permits a duplicate run on a
 * genuinely-slow row, caught by the action layer's real-world dedup (design D4).
 * Terminal rows (`done`/`no_action`/`failed`) are never touched, however old.
 *
 * Returns the deleted rows' claim tuples so the caller can re-list them and
 * write one audit row per reset (with a shared `sweepId`).
 */
export async function resetStuckProcessingEmails(graceMs: number): Promise<StuckClaimKey[]> {
  const cutoff = new Date(Date.now() - graceMs);
  return db
    .delete(processedEmails)
    .where(and(eq(processedEmails.status, "processing"), lt(processedEmails.claimedAt, cutoff)))
    .returning({
      workflowId: processedEmails.workflowId,
      connectionId: processedEmails.connectionId,
      providerMessageId: processedEmails.providerMessageId,
    });
}
