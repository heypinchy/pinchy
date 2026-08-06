import { and, eq, gt, inArray, lt, sql } from "drizzle-orm";
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

/**
 * Attach OpenClaw's approval id to the confirmation waiting for that call.
 *
 * Returns the row it linked, or `null` when nothing was waiting — which is the
 * ordinary case, not a fault: the same gateway broadcast carries OpenClaw's own
 * approvals (skill workshop, exec), and those name calls Pinchy never opened a
 * row for.
 *
 * Restricted to `pending`: a late broadcast must not re-arm a confirmation the
 * user has already decided, or a settled card would look resolvable again.
 */
export async function linkApproval(input: {
  approvalId: string;
  toolCallId: string;
}): Promise<{ id: string } | null> {
  const [linked] = await db
    .update(toolApproval)
    .set({ openclawApprovalId: input.approvalId })
    .where(and(eq(toolApproval.toolCallId, input.toolCallId), eq(toolApproval.status, "pending")))
    .returning({ id: toolApproval.id });
  return linked ?? null;
}

/**
 * How long a decision may wait for {@link linkApproval} to land.
 *
 * The gap is structural, not a hiccup: OpenClaw mints its approval id only
 * AFTER `before_tool_call` answers `requireApproval`, and announces it on a
 * separate gateway broadcast. Pinchy's own row — and the `approval.requested`
 * audit event the inbox and the E2E both key on — therefore exist before the id
 * does. Anything that reacts to the card the instant it appears lands in that
 * window.
 *
 * Two seconds is a BOUND, not a measurement, and the difference is worth being
 * honest about. The failing CI run shows the gate's `plugin.approval.request`
 * answered in 83 ms and the decision arriving roughly half a second later with
 * the link still unattached — then the stack came down, so how long the hop
 * actually takes was never observed. So this is ~4x the window that
 * demonstrably was not enough, over a path that is one websocket frame plus one
 * indexed UPDATE, and short enough that no decision ever feels hung.
 *
 * It is only ever spent inside the window: a row that already carries the id,
 * or that no broadcast can reach, returns immediately. And if it ever does
 * prove short, the symptom is the same honest `resumed: false` it replaced,
 * from one place — not a new failure mode.
 */
export const APPROVAL_LINK_WAIT_MS = 2000;

/** Re-read cadence for {@link waitForApprovalLink}. Short because the wait is
 * short; the read is a single indexed lookup by primary key. */
const APPROVAL_LINK_POLL_MS = 50;

/**
 * Wait for OpenClaw's approval id to reach this user's pending confirmation,
 * and return it — or `null` when it is not coming.
 *
 * Deciding without it is not merely a missed resume, it is a permanent one:
 * {@link linkApproval} refuses a row that is no longer `pending`, so flipping
 * the row first makes an in-flight link undeliverable forever, and the parked
 * run then sits until OpenClaw's 600 s cap. The decision route reports that as
 * `resumed: false` / `nothing-waiting` — a false statement about a call that IS
 * waiting. Seen on CI 2026-08-06, where the E2E granted its own confirmation
 * ~0.6 s after the gate opened it.
 *
 * Four things end the wait immediately rather than burning the deadline:
 * the id is already there; the row is gone; it is no longer `pending` (nothing
 * can link it any more); or it carries no `toolCallId`, which is the key
 * `linkApproval` matches on — no broadcast can ever name it.
 *
 * `requesterId` scopes the wait to the caller's own row. `resolveDecision`
 * remains the authority on who may decide; this only avoids making a stranger's
 * request measurably slower than an unknown one, which would answer a question
 * the 403 is careful not to.
 */
export async function waitForApprovalLink(input: {
  id: string;
  requesterId: string;
  timeoutMs?: number;
  pollMs?: number;
  /** Seam for tests; defaults to a real timer. */
  sleep?: (ms: number) => Promise<void>;
  /** Seam for tests; defaults to the wall clock. */
  now?: () => number;
}): Promise<string | null> {
  const timeoutMs = input.timeoutMs ?? APPROVAL_LINK_WAIT_MS;
  const pollMs = input.pollMs ?? APPROVAL_LINK_POLL_MS;
  const sleep = input.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms)));
  const now = input.now ?? Date.now;
  const deadline = now() + timeoutMs;

  for (;;) {
    const [row] = await db
      .select({
        approvalId: toolApproval.openclawApprovalId,
        status: toolApproval.status,
        requesterId: toolApproval.requesterId,
        toolCallId: toolApproval.toolCallId,
      })
      .from(toolApproval)
      .where(eq(toolApproval.id, input.id))
      .limit(1);

    if (!row || row.requesterId !== input.requesterId) return null;
    if (row.approvalId) return row.approvalId;
    if (row.status !== "pending" || !row.toolCallId) return null;
    if (now() >= deadline) return null;
    await sleep(pollMs);
  }
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
        inArray(toolApproval.status, allowed ? ["pending", "approved"] : ["pending"])
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
