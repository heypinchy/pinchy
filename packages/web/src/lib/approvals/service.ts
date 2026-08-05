import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { toolApproval } from "@/db/schema";

/** Default lifetime of a pending confirmation. The acting user is present, so
 * this is short — past it the request fails closed. */
export const DEFAULT_CONFIRM_TTL_MS = 15 * 60 * 1000;

/**
 * How many confirmations one person may have open on one agent at a time.
 *
 * A retry with the SAME arguments reuses its pending row, but a changed
 * argument opens a new one — and the only thing telling the model to stop is
 * the block reason, which is a prompt rather than a bound. A model that keeps
 * adjusting an argument therefore opens one confirmation per attempt: a wall of
 * cards in the requester's inbox now, and one `approval.expired` audit row per
 * request at the next sweep, each taking the audit log's single advisory lock
 * (AGENTS.md §"An audit row … needs a bound").
 *
 * Generous for a human — nobody works through twenty cards and wants a
 * twenty-first — and small enough that the burst stays a burst.
 */
export const MAX_PENDING_PER_REQUESTER = 20;

export type GateDecision = {
  decision: "allow" | "block";
  requestId: string;
  /** True only when a brand-new pending request row was inserted — lets the
   * route audit `approval.requested` once, not on every retry. */
  created: boolean;
  /** Set when the block is backpressure — the requester is at
   * {@link MAX_PENDING_PER_REQUESTER} and nothing new was opened. `requestId`
   * then names one of the confirmations already waiting, not a new one. */
  limited?: boolean;
};

export interface DecideGateInput {
  agentId: string;
  requesterId: string;
  sessionKey: string;
  toolName: string;
  /** The OpenClaw call this decision is about. Stored so an arriving approval
   * broadcast can be matched back to this row. */
  toolCallId?: string;
  argsDigest: string;
  argsSummary?: Record<string, unknown>;
  /** Override "now" for tests. */
  now?: Date;
  /** Override the pending TTL (negative ⇒ already expired, for tests). */
  ttlMs?: number;
}

/**
 * The gate's decision for one tool call, bound to (agent, requester, session,
 * toolName, argsDigest) — toolName is part of the binding because two gated
 * tools can receive identical params (the odoo record-action family all take
 * `{ target: <ref> }`), and an approval must clear exactly the action the
 * user saw:
 *   1. consume exactly one approved, unexpired ticket → allow;
 *   2. else reuse an existing unexpired pending request → block;
 *   3. else refuse to open one past {@link MAX_PENDING_PER_REQUESTER} → block;
 *   4. else create a new pending request → block.
 * Consume step 1 uses `FOR UPDATE SKIP LOCKED` so concurrent retries consume
 * at most one ticket.
 */
export async function decideGate(input: DecideGateInput): Promise<GateDecision> {
  const now = input.now ?? new Date();

  const nowIso = now.toISOString();
  const consumed = (await db.execute(sql`
    UPDATE tool_approval
    SET status = 'consumed', consumed_at = ${nowIso}::timestamptz
    WHERE id = (
      SELECT id FROM tool_approval
      WHERE agent_id = ${input.agentId}
        AND requester_id = ${input.requesterId}
        AND session_key = ${input.sessionKey}
        AND tool_name = ${input.toolName}
        AND args_digest = ${input.argsDigest}
        AND status = 'approved'
        AND expires_at > ${nowIso}::timestamptz
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING id
  `)) as unknown as { id: string }[];
  if (consumed.length > 0) {
    return { decision: "allow", requestId: consumed[0].id, created: false };
  }

  const existing = await db
    .select({ id: toolApproval.id })
    .from(toolApproval)
    .where(
      and(
        eq(toolApproval.agentId, input.agentId),
        eq(toolApproval.requesterId, input.requesterId),
        eq(toolApproval.sessionKey, input.sessionKey),
        eq(toolApproval.toolName, input.toolName),
        eq(toolApproval.argsDigest, input.argsDigest),
        eq(toolApproval.status, "pending"),
        gt(toolApproval.expiresAt, now)
      )
    )
    .limit(1);
  if (existing.length > 0) {
    // Re-point the reused row at the call that is waiting NOW. Every attempt
    // gets a fresh toolCallId, so leaving the one that opened the row would
    // resolve an approval OpenClaw has already discarded: the user clicks
    // approve, gets a success toast, and the run stays stuck.
    //
    // Only when the new attempt actually carries an id — overwriting a usable
    // one with `undefined` trades a stale target for no target at all.
    if (input.toolCallId) {
      await db
        .update(toolApproval)
        .set({ toolCallId: input.toolCallId })
        .where(eq(toolApproval.id, existing[0].id));
    }
    return { decision: "block", requestId: existing[0].id, created: false };
  }

  // Backpressure, checked only here: it must never stand between a user and a
  // ticket they already approved, so it sits after the consume step and after
  // the reuse step (a retry of an already-open confirmation opens nothing).
  // One query answers both halves — at the cap, and which confirmation to name.
  const waiting = await db
    .select({ id: toolApproval.id })
    .from(toolApproval)
    .where(
      and(
        eq(toolApproval.agentId, input.agentId),
        eq(toolApproval.requesterId, input.requesterId),
        eq(toolApproval.status, "pending"),
        gt(toolApproval.expiresAt, now)
      )
    )
    .orderBy(toolApproval.createdAt)
    .limit(MAX_PENDING_PER_REQUESTER);
  if (waiting.length >= MAX_PENDING_PER_REQUESTER) {
    return { decision: "block", requestId: waiting[0].id, created: false, limited: true };
  }

  const ttlMs = input.ttlMs ?? DEFAULT_CONFIRM_TTL_MS;
  const [inserted] = await db
    .insert(toolApproval)
    .values({
      agentId: input.agentId,
      requesterId: input.requesterId,
      sessionKey: input.sessionKey,
      toolName: input.toolName,
      toolCallId: input.toolCallId,
      argsDigest: input.argsDigest,
      argsSummary: input.argsSummary,
      tier: "confirm",
      status: "pending",
      expiresAt: new Date(now.getTime() + ttlMs),
    })
    .returning({ id: toolApproval.id });
  return { decision: "block", requestId: inserted.id, created: true };
}

export type ResolveResult =
  | { ok: true; request: typeof toolApproval.$inferSelect }
  | { ok: false; reason: "not_found" | "not_pending" | "forbidden" };

export interface ResolveDecisionInput {
  id: string;
  approverId: string;
  decision: "approve" | "deny";
  reason?: string;
  /** Tier 2: the approver must be the original requester. */
  selfConfirmOnly?: boolean;
  now?: Date;
}

export async function resolveDecision(input: ResolveDecisionInput): Promise<ResolveResult> {
  const now = input.now ?? new Date();
  const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, input.id)).limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  // Authorization before state: a non-requester must never learn whether the
  // request is still actionable.
  if (input.selfConfirmOnly && row.requesterId !== input.approverId) {
    return { ok: false, reason: "forbidden" };
  }
  // An expired request is no longer actionable even while the sweep hasn't
  // flipped it yet: approving it would mint a grant the consume step (which
  // checks expires_at) can never honor — a success toast over a dead grant.
  if (row.status !== "pending" || row.expiresAt <= now) {
    return { ok: false, reason: "not_pending" };
  }

  const [updated] = await db
    .update(toolApproval)
    .set({
      status: input.decision === "approve" ? "approved" : "denied",
      approverId: input.approverId,
      decisionReason: input.reason ?? null,
      decidedAt: now,
    })
    .where(and(eq(toolApproval.id, input.id), eq(toolApproval.status, "pending")))
    .returning();
  if (!updated) return { ok: false, reason: "not_pending" };
  return { ok: true, request: updated };
}

/** One row flipped by {@link expireStale} — enough to audit `approval.expired`. */
export interface ExpiredApproval {
  id: string;
  agentId: string;
  requesterId: string;
  toolName: string;
  argsDigest: string;
}

/** Flip overdue pending requests to `expired`. Returns the flipped rows so the
 * sweep can emit one `approval.expired` audit entry per request. */
export async function expireStale(now?: Date): Promise<ExpiredApproval[]> {
  const at = now ?? new Date();
  return await db
    .update(toolApproval)
    .set({ status: "expired" })
    .where(and(eq(toolApproval.status, "pending"), lt(toolApproval.expiresAt, at)))
    .returning({
      id: toolApproval.id,
      agentId: toolApproval.agentId,
      requesterId: toolApproval.requesterId,
      toolName: toolApproval.toolName,
      argsDigest: toolApproval.argsDigest,
    });
}
