/**
 * Durable store for the chat "paused" banner (Concern 1).
 *
 * A live OpenClaw error chunk paints an ephemeral bubble over the WS, but that
 * bubble dies on reload/reconnect. This store keeps the latest agent error for
 * a session so the chat can re-surface it on return — without touching the
 * fragile WS history-reconcile path (the banner is a separate, server-backed
 * surface).
 *
 * Resolution is two-state and deliberately separate:
 *   - `supersededAt` — the triggering message's run later SUCCEEDED, so the
 *     error is stale. Scoped to the triggering `clientMessageId` so an
 *     unrelated later message succeeding does NOT clear an unanswered error.
 *   - `dismissedAt` — the user explicitly acknowledged it. Scoped to the owner.
 *
 * `getActiveChatSessionError` filters on the EXACT `sessionKey`
 * (`agent:{agentId}:direct:{userId}`) — never a prefix — so errors can't leak
 * across sessions or users.
 */
import { and, desc, eq, isNull } from "drizzle-orm";

import { db } from "@/db";
import { chatSessionErrors } from "@/db/schema";

export interface RecordChatSessionErrorInput {
  userId: string;
  agentId: string;
  sessionKey: string;
  clientMessageId?: string | null;
  runId?: string | null;
  agentName: string;
  model?: string | null;
  errorClass: string;
  transientReason?: string | null;
  providerError: string;
  sideEffects: boolean;
}

export type ChatSessionError = typeof chatSessionErrors.$inferSelect;

export async function recordChatSessionError(
  input: RecordChatSessionErrorInput
): Promise<ChatSessionError> {
  const [row] = await db
    .insert(chatSessionErrors)
    .values({
      userId: input.userId,
      agentId: input.agentId,
      sessionKey: input.sessionKey,
      clientMessageId: input.clientMessageId ?? null,
      runId: input.runId ?? null,
      agentName: input.agentName,
      model: input.model ?? null,
      errorClass: input.errorClass,
      transientReason: input.transientReason ?? null,
      providerError: input.providerError,
      sideEffects: input.sideEffects,
    })
    .returning();
  return row;
}

/**
 * The newest un-superseded, un-dismissed error for the exact session, or null.
 */
export async function getActiveChatSessionError(
  sessionKey: string
): Promise<ChatSessionError | null> {
  const [row] = await db
    .select()
    .from(chatSessionErrors)
    .where(
      and(
        eq(chatSessionErrors.sessionKey, sessionKey),
        isNull(chatSessionErrors.supersededAt),
        isNull(chatSessionErrors.dismissedAt)
      )
    )
    .orderBy(desc(chatSessionErrors.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Mark the session's un-resolved error(s) superseded because the triggering
 * message's run succeeded. Requires `clientMessageId` — superseding on bare
 * session completion would wrongly clear an unanswered error when the user
 * simply moved on to a different question.
 */
export async function supersedeChatSessionErrors({
  sessionKey,
  clientMessageId,
}: {
  sessionKey: string;
  clientMessageId?: string | null;
}): Promise<void> {
  if (!clientMessageId) return;
  await db
    .update(chatSessionErrors)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(chatSessionErrors.sessionKey, sessionKey),
        eq(chatSessionErrors.clientMessageId, clientMessageId),
        isNull(chatSessionErrors.supersededAt)
      )
    );
}

/**
 * Dismiss an error by id, scoped to its owner. Returns the updated row, or null
 * when no row matched (wrong id or not the owner).
 */
export async function dismissChatSessionError({
  id,
  userId,
}: {
  id: string;
  userId: string;
}): Promise<ChatSessionError | null> {
  const [row] = await db
    .update(chatSessionErrors)
    .set({ dismissedAt: new Date() })
    .where(
      and(
        eq(chatSessionErrors.id, id),
        eq(chatSessionErrors.userId, userId),
        isNull(chatSessionErrors.dismissedAt)
      )
    )
    .returning();
  return row ?? null;
}
