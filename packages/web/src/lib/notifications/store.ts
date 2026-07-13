import { db } from "@/db";
import { notifications, notificationRecipients } from "@/db/schema";
import type { NotificationStatus } from "@/db/enums";

export interface NotifyInput {
  /** The agent whose background run produced this output. */
  agentId: string;
  title: string;
  content: string;
  status: NotificationStatus;
  /** Present on `status: "failure"`; the operator-facing error summary. */
  errorMessage?: string;
  /** Source-agnostic provenance: `"inbox"` | `"briefing"` | … (no FK). */
  sourceType?: string;
  /** The producing run / ledger-row id (no FK; survives source deletion). */
  sourceId?: string;
  /** Users who should see this in their Activity feed. Must be non-empty. */
  recipientUserIds: string[];
}

/**
 * Create a background-run notification and fan it out to every recipient
 * (foundation #704). The notification and its per-user recipient rows are
 * written in one transaction, so a partial fan-out can never leave a
 * notification that only some intended recipients can see.
 *
 * Output of a background run lands here, never in chat. Each recipient row
 * starts unread (`readAt` null); the per-user unread index powers the feed
 * badge. Returns the new notification id.
 *
 * An empty `recipientUserIds` is a caller bug — a notification nobody can see —
 * so we throw *before* any insert rather than persist an orphan notification.
 */
export async function notify(input: NotifyInput): Promise<string> {
  if (input.recipientUserIds.length === 0) {
    throw new Error("notify: at least one recipient is required");
  }

  return db.transaction(async (tx) => {
    const [row] = await tx
      .insert(notifications)
      .values({
        agentId: input.agentId,
        title: input.title,
        content: input.content,
        status: input.status,
        errorMessage: input.errorMessage ?? null,
        sourceType: input.sourceType ?? null,
        sourceId: input.sourceId ?? null,
      })
      .returning({ id: notifications.id });

    await tx.insert(notificationRecipients).values(
      input.recipientUserIds.map((userId) => ({
        userId,
        notificationId: row.id,
      }))
    );

    return row.id;
  });
}
