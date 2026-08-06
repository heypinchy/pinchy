import { and, eq, gt, inArray, isNull, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { toolApproval } from "@/db/schema";

/**
 * Default lifetime of a pending confirmation. The acting user is present, so
 * this is short — past it the request fails closed.
 *
 * Pinned to `APPROVAL_TIMEOUT_MS` in `pinchy-approvals/gate.ts`, which is
 * OpenClaw's hard cap for a parked tool call. A longer TTL here does not buy
 * the user more time; it only keeps a card clickable over a run that has
 * already timed out (guarded by approvals-ttl-drift.test.ts).
 */
export const DEFAULT_CONFIRM_TTL_MS = 10 * 60 * 1000;

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
    .select({ id: toolApproval.id, toolCallId: toolApproval.toolCallId })
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
    // The approval id has to go with it, and for the same reason: OpenClaw
    // mints one approval per attempt and drops the one before it, so an id
    // belonging to the previous call is already dead. Clearing it is what lets
    // the next broadcast land at all — {@link linkApproval} refuses to
    // overwrite an id, so a dead one left here would be permanent.
    //
    // Only when the new attempt actually carries an id, and only when that id
    // has really changed: overwriting a usable target with `undefined` trades a
    // stale one for none, and re-clearing on a repeated gate-check for the SAME
    // call would throw away an approval that is still live.
    if (input.toolCallId && input.toolCallId !== existing[0].toolCallId) {
      await db
        .update(toolApproval)
        .set({ toolCallId: input.toolCallId, openclawApprovalId: null })
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

/**
 * Attach OpenClaw's approval id to the confirmation waiting for that call.
 *
 * Returns the row it linked, or `null` when nothing was waiting — which is the
 * ordinary case, not a fault: the same gateway broadcast carries OpenClaw's own
 * approvals (skill workshop, exec), and those name calls Pinchy never opened a
 * row for.
 *
 * Accepts a confirmation the user has ALREADY decided, and that is the point.
 * The decision route flips the row before it resolves, so a broadcast arriving
 * after a fast decision finds a row that is no longer `pending` — and rejecting
 * it there does not lose a race, it makes the link permanently impossible while
 * the run stays parked. Recording the id re-arms nothing: the inbox lists on
 * `status = pending`, so a decided confirmation stays gone from it either way.
 * What the id buys is the ability to deliver a decision already made.
 *
 * Never overwrites an id already on the row — two approvals for ONE call cannot
 * both be live, and the first is the one the run is waiting on. That is a rule
 * about the call, not about the row: a retry re-points the row at a new call,
 * and {@link decideGate} clears the id in the same statement precisely so the
 * new call's broadcast can land here. A finished confirmation is skipped: an
 * address nobody will write to is noise.
 *
 * Scoped to the broadcast's session when it names one — see {@link sessionScope}.
 */
export async function linkApproval(input: {
  approvalId: string;
  toolCallId: string;
  sessionKey?: string;
}): Promise<{ id: string } | null> {
  const [linked] = await db
    .update(toolApproval)
    .set({ openclawApprovalId: input.approvalId })
    .where(
      and(
        eq(toolApproval.toolCallId, input.toolCallId),
        isNull(toolApproval.openclawApprovalId),
        inArray(toolApproval.status, ["pending", "approved", "denied"]),
        ...sessionScope(input.sessionKey)
      )
    )
    .returning({ id: toolApproval.id });
  return linked ?? null;
}

/** How long a decision waits for the broadcast that names the parked call, and
 * how often it looks. The observed gap is one `plugin.approval.request` round
 * trip (~125 ms on a loaded CI runner) plus the broadcast hop, so this is
 * roughly an order of magnitude of headroom over the case it exists for. */
const LINK_WAIT_MS = 2_000;
const LINK_POLL_MS = 40;

/**
 * Wait for the approval broadcast to name the call this confirmation is holding.
 *
 * A decision made in a confirmation's first moments gets here before the
 * broadcast does: the gate writes `approval.requested` from inside gate-check,
 * so the card is actionable a full `plugin.approval.request` round trip before
 * Pinchy learns OpenClaw's id. Answering "nothing is waiting" in that window is
 * simply untrue — the run IS parked, we just do not know its address yet, and
 * the user is told their approval did not take when it did.
 *
 * Bounded, because the broadcast may genuinely never come (the bridge was down,
 * Pinchy restarted after it, or the row predates #1132). Then the honest answer
 * is "no", and it has to arrive rather than hang.
 */
export async function awaitApprovalLink(
  id: string,
  opts: { timeoutMs?: number; pollMs?: number } = {}
): Promise<string | null> {
  const pollMs = opts.pollMs ?? LINK_POLL_MS;
  const deadline = Date.now() + (opts.timeoutMs ?? LINK_WAIT_MS);
  for (;;) {
    const [row] = await db
      .select({ approvalId: toolApproval.openclawApprovalId })
      .from(toolApproval)
      .where(eq(toolApproval.id, id))
      .limit(1);
    if (row?.approvalId) return row.approvalId;
    if (Date.now() >= deadline) return null;
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

/**
 * Why a tool call id is not a key on its own.
 *
 * It is only as unique as the model provider makes it. Several self-hosted
 * OpenAI-compatible servers number tool calls per response (`call_0`, `call_1`),
 * and Pinchy explicitly supports those deployments, so two people can hold
 * pending confirmations under one id at the same moment. Matching on the id
 * alone then touches BOTH rows: one Approve resumes a call nobody confirmed,
 * and one resolution report spends a grant the runtime said nothing about —
 * with only one of the two rows getting an audit entry.
 *
 * The session is what tells them apart, and both callers already have it: the
 * approval OpenClaw broadcasts carries `sessionKey` verbatim, and the gate's
 * `onResolution` reports from the same hook context the gate-check read.
 *
 * Optional rather than required, deliberately: narrowing must never cost a
 * match that works today. A caller that names no session falls back to the id
 * alone, exactly as before — and a Pinchy row always has a session, because
 * gate-check refuses to open a confirmation without one.
 */
function sessionScope(sessionKey: string | undefined) {
  return sessionKey ? [eq(toolApproval.sessionKey, sessionKey)] : [];
}

/** What OpenClaw finally did with a parked call — mirrors the plugin's
 * `ApprovalResolution`. The last two never come from a button. */
export type ApprovalResolution = "allow-once" | "allow-always" | "deny" | "timeout" | "cancelled";

/** The row a resolution settled, or `null` when it settled nothing. */
export interface SettledApproval {
  id: string;
  agentId: string;
  requesterId: string;
  toolName: string;
  argsDigest: string;
  status: "consumed" | "denied" | "expired";
}

/**
 * Record what OpenClaw actually did with the call a confirmation was holding up.
 *
 * This is the outcome channel the decision route cannot be: it also covers the
 * resolutions no button produces — the run stopped waiting, or was cancelled —
 * which would otherwise leave a row `pending` and a card in the inbox over a
 * call that is already gone.
 *
 * Every branch moves the row out of a state the decision route may also be
 * moving it out of, so each one names the states it accepts and reports what it
 * actually changed. Returning `null` means nothing was settled — either the
 * user's own decision got there first (already flipped and already audited, so
 * a second audit row would be a duplicate) or the call was never ours: the same
 * approval machinery carries OpenClaw's own requests (skill workshop, exec).
 */
export async function recordResolution(input: {
  toolCallId: string;
  /** The session the runtime reported on — see {@link sessionScope}. */
  sessionKey?: string;
  decision: ApprovalResolution;
  now?: Date;
}): Promise<SettledApproval | null> {
  const now = input.now ?? new Date();
  const allowed = input.decision === "allow-once" || input.decision === "allow-always";
  // A grant is spent the moment OpenClaw acts on it: the call resumes inside
  // the hook and never passes the gate again, so no later consume step exists
  // to do this.
  const next = allowed ? "consumed" : input.decision === "deny" ? "denied" : "expired";

  const [settled] = await db
    .update(toolApproval)
    .set({
      status: next,
      ...(allowed ? { consumedAt: now } : {}),
      ...(input.decision === "deny" ? { decidedAt: now } : {}),
    })
    .where(
      and(
        eq(toolApproval.toolCallId, input.toolCallId),
        // An allow follows the user's approval, so `approved` is the expected
        // state — `pending` too, because a resolution can arrive from another
        // approval surface. Everything else is already settled.
        inArray(toolApproval.status, allowed ? ["pending", "approved"] : ["pending"]),
        ...sessionScope(input.sessionKey)
      )
    )
    .returning({
      id: toolApproval.id,
      agentId: toolApproval.agentId,
      requesterId: toolApproval.requesterId,
      toolName: toolApproval.toolName,
      argsDigest: toolApproval.argsDigest,
    });
  return settled ? { ...settled, status: next } : null;
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
