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
 *   - `supersededAt` — a later turn of the session SUCCEEDED, so the error is
 *     stale (`supersedeChatSessionErrors`).
 *   - `dismissedAt` — the user explicitly acknowledged it. Scoped to the owner.
 *
 * `getActiveChatSessionError` filters on the EXACT `sessionKey`
 * (`agent:{agentId}:direct:{userId}`) — never a prefix — so errors can't leak
 * across sessions or users.
 */
import { and, desc, eq, gte, inArray, isNull, like, lte } from "drizzle-orm";

import { db } from "@/db";
import { chatSessionErrors, auditLog } from "@/db/schema";
import { resolveActorIdMatchSet } from "@/lib/audit";

/**
 * Did the agent execute any tool for `userId` since `since`? Used to set
 * `sideEffects` on a persisted error so the banner can warn that a retry may
 * DUPLICATE writes.
 *
 * OpenClaw does not surface tool execution as a chat-stream chunk (verified by
 * E2E: a `tool.*` audit row lands but no `tool_use` chunk reaches the router),
 * so the audit trail is the only reliable signal. Scoped by
 * `resource = agent:{agentId}` (its case is stable), a time lower bound, and
 * the caller as actor.
 *
 * The actor scope is a confidentiality boundary, not a precision tweak. A
 * shared agent is one agent for every member, and the retry gate answers this
 * question to whoever can poll it — counting the whole agent told a member
 * whether a colleague had just run a tool (#1274). The tool-use route writes
 * the user from the run's session key as actor, so the caller's own writes
 * stay in scope. The match set covers every value that row can hold: the
 * pseudonym `appendAuditLog` substitutes, the raw id, and the lowercased id the
 * route keeps when it cannot map OpenClaw's lowercased session key back to
 * `users.id` — missing any of them is the dangerous direction, an unguarded
 * Retry after a write.
 */
export async function agentRanToolSince(
  agentId: string,
  userId: string,
  since: Date
): Promise<boolean> {
  const actorIds = new Set(await resolveActorIdMatchSet(userId));
  actorIds.add(userId.toLowerCase());
  const [row] = await db
    .select({ id: auditLog.id })
    .from(auditLog)
    .where(
      and(
        eq(auditLog.resource, `agent:${agentId}`),
        like(auditLog.eventType, "tool.%"),
        gte(auditLog.timestamp, since),
        eq(auditLog.actorType, "user"),
        inArray(auditLog.actorId, [...actorIds])
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
 * How long an unresolved error may stay the session's banner. The banner
 * answers "did something go wrong while I was away?" — by the next day that
 * question is stale, and a banner from yesterday covering today's first answer
 * is noise (#1301). A lasting cause fails the next message again, and that
 * failure brings its own banner.
 */
export const ACTIVE_ERROR_MAX_AGE_MS = 24 * 60 * 60 * 1000;

/**
 * The newest un-superseded, un-dismissed, banner-eligible error for the exact
 * session, younger than `ACTIVE_ERROR_MAX_AGE_MS`, or null. `showBanner` is
 * what keeps the classes recorded only for the retry gate (#1013) out of a
 * surface they were never shown on.
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
        isNull(chatSessionErrors.dismissedAt),
        gte(chatSessionErrors.createdAt, new Date(Date.now() - ACTIVE_ERROR_MAX_AGE_MS))
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
      userId: chatSessionErrors.userId,
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
  return agentRanToolSince(agentId, row.userId, row.runStartedAt);
}

/**
 * Mark the session's un-resolved errors recorded up to `before` superseded,
 * because a later turn of the session succeeded.
 *
 * Every earlier error, not only the one the succeeding message raised. This
 * used to require the triggering `clientMessageId`, on the theory that a user
 * who moved on to another question still wants the unanswered one flagged. In
 * practice the banner then sat above every later answer, reload after reload,
 * hours after the fact (#1301) — and the docs had promised all along that it
 * "clears itself automatically as soon as a message goes through again".
 *
 * `before` is app time compared against `created_at`, which the database fills
 * with `now()` — the same convention as `agentRanToolSince`, and sound on the
 * UTC session the Pinchy stack runs its database with.
 */
export async function supersedeChatSessionErrors({
  sessionKey,
  before,
}: {
  sessionKey: string;
  before: Date;
}): Promise<void> {
  await db
    .update(chatSessionErrors)
    .set({ supersededAt: new Date() })
    .where(
      and(
        eq(chatSessionErrors.sessionKey, sessionKey),
        lte(chatSessionErrors.createdAt, before),
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
