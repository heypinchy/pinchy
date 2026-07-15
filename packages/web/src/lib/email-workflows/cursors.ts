import { eq } from "drizzle-orm";
import { db } from "@/db";
import { emailConnectionCursors } from "@/db/schema";

/**
 * Per-connection sync cursor (design §4/D2): an opaque provider token — Gmail
 * `historyId`, Graph `deltaLink`, or a timestamp — marking "what's new since the
 * last tick" for one mailbox, shared by every workflow on it.
 *
 * The cursor is a **performance optimization, not correctness**: it lets a poll
 * ask the provider only for recent mail instead of re-listing everything. The
 * `processed_emails` ledger + reconciliation sweep are the durable truth, so a
 * lost, stale, or expired cursor (Gmail 404 / Graph 410) never causes
 * double-processing — the sweep re-lists and the ledger dedups the resync.
 *
 * This module is just read + last-write-wins upsert. The load-bearing ordering
 * ("advance only AFTER claims are durable", design §8) lives in the orchestrator
 * that calls these, not here.
 */

/** The connection's current cursor, or null if it has never been advanced. */
export async function readCursor(connectionId: string): Promise<string | null> {
  const [row] = await db
    .select({ cursor: emailConnectionCursors.cursor })
    .from(emailConnectionCursors)
    .where(eq(emailConnectionCursors.connectionId, connectionId));
  return row?.cursor ?? null;
}

/** Upsert the connection's cursor to `cursor` (last write wins). */
export async function advanceCursor(connectionId: string, cursor: string): Promise<void> {
  await db
    .insert(emailConnectionCursors)
    .values({ connectionId, cursor })
    .onConflictDoUpdate({
      target: emailConnectionCursors.connectionId,
      set: { cursor, updatedAt: new Date() },
    });
}
