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
import { and, desc, eq, gte, isNull, like } from "drizzle-orm";

import { db } from "@/db";
import { chatSessionErrors, auditLog } from "@/db/schema";

/**
 * Did the agent execute any tool since `since`? Used to set `sideEffects` on a
 * persisted error so the banner can warn that a retry may DUPLICATE writes.
 *
 * OpenClaw does not surface tool execution as a chat-stream chunk (verified by
 * E2E: a `tool.*` audit row lands but no `tool_use` chunk reaches the router),
 * so the audit trail is the only reliable signal. This runs only on the rare
 * error-persist path (once per failed run), not the hot history-load path, so
 * the audit-table read is acceptable. Scoped by `resource = agent:{agentId}`
 * (its case is stable, unlike the lowercased tool-audit `actorId`) plus a time
 * lower bound — it never misses a tool this run performed (the dangerous
 * false-negative); a different user's tool on a shared agent in the same narrow
 * window can over-warn, which is the safe direction.
 */
export async function agentRanToolSince(agentId: string, since: Date): Promise<boolean> {
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.resource, `agent:${agentId}`),
        like(auditLog.eventType, "tool.%"),
        gte(auditLog.timestamp, since)
      )
    )
    .limit(1);
  return !!row;
}

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
  /**
   * Lower bound `sideEffects` was derived over, so the question can be asked
   * again later (#1013). Omitted only by callers that genuinely have no run
   * window; the gate then falls back to the stored flag.
   */
  runStartedAt?: Date | null;
  /**
   * Whether this failure may re-surface as the durable "paused" banner.
   * Defaults to true — every caller that records a banner-worthy error keeps
   * its existing behaviour, and only the two that must NOT show a banner say so
   * explicitly.
   */
  showBanner?: boolean;
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
      runStartedAt: input.runStartedAt ?? null,
      showBanner: input.showBanner ?? true,
    })
    .returning();
  return row;
}

/**
 * The newest un-superseded, un-dismissed, banner-eligible error for the exact
 * session, or null. `showBanner` is what keeps the classes recorded only for
 * the retry gate (#1013) out of a surface they were never shown on.
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
        eq(chatSessionErrors.showBanner, true),
        isNull(chatSessionErrors.supersededAt),
        isNull(chatSessionErrors.dismissedAt)
      )
    )
    .orderBy(desc(chatSessionErrors.createdAt))
    .limit(1);
  return row ?? null;
}

/**
 * Does retrying this session's latest failed run risk DUPLICATING writes?
 *
 * The same question `persistDurableChatError` answers when the error arrives —
 * asked again, later. That is the whole fix for #1013: OpenClaw fires
 * `after_tool_call` without awaiting it, so `pinchy-audit`'s `tool.*` row is
 * ordered against nothing and can still be in flight when the run fails. The
 * derivation at error time therefore reads `false` for a run that already
 * acted, and the user is offered an unguarded Retry. By the time somebody has
 * read an error and reached for Retry, the row is long committed.
 *
 * Two properties are load-bearing:
 *
 *  - **Monotonic.** A stored `true` is never re-opened. It was derived from a
 *    row that existed; a later window that finds nothing (GC, a clock jump)
 *    must not turn a warned retry into an unwarned one.
 *  - **Newest failure only, whatever its resolution state.** Falling back to an
 *    older row's window would warn about writes the run being retried never
 *    made, and a confirm that cries wolf is one users learn to click through.
 *    Superseded/dismissed rows are NOT filtered out: dismissing a banner does
 *    not un-run a tool, and the newest row is by construction the failure the
 *    user is looking at.
 *
 * Rows written before migration 0064 carry no `runStartedAt`. There is no
 * honest window for them, so they report their stored flag rather than
 * re-deriving over an invented range.
 */
export async function resolveRetryGate({
  sessionKey,
  agentId,
}: {
  sessionKey: string;
  agentId: string;
}): Promise<boolean> {
  const [row] = await db
    .select({
      sideEffects: chatSessionErrors.sideEffects,
      runStartedAt: chatSessionErrors.runStartedAt,
    })
    .from(chatSessionErrors)
    .where(eq(chatSessionErrors.sessionKey, sessionKey))
    .orderBy(desc(chatSessionErrors.createdAt))
    .limit(1);

  if (!row) return false;
  if (row.sideEffects) return true;
  if (!row.runStartedAt) return false;
  return agentRanToolSince(agentId, row.runStartedAt);
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
