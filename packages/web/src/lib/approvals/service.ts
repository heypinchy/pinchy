import { and, eq, gt, lt, sql } from "drizzle-orm";
import { db } from "@/db";
import { toolApproval } from "@/db/schema";

/** Default lifetime of a pending confirmation. The acting user is present, so
 * this is short — past it the request fails closed. */
export const DEFAULT_CONFIRM_TTL_MS = 15 * 60 * 1000;

export type GateDecision = {
  decision: "allow" | "block";
  requestId: string;
  /** True only when a brand-new pending request row was inserted — lets the
   * route audit `approval.requested` once, not on every retry. */
  created: boolean;
};

export interface DecideGateInput {
  agentId: string;
  requesterId: string;
  sessionKey: string;
  toolName: string;
  argsDigest: string;
  argsSummary?: Record<string, unknown>;
  /** Override "now" for tests. */
  now?: Date;
  /** Override the pending TTL (negative ⇒ already expired, for tests). */
  ttlMs?: number;
}

/**
 * The gate's decision for one tool call, bound to (agent, requester, session,
 * argsDigest):
 *   1. consume exactly one approved, unexpired ticket → allow;
 *   2. else reuse an existing unexpired pending request → block;
 *   3. else create a new pending request → block.
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
        eq(toolApproval.argsDigest, input.argsDigest),
        eq(toolApproval.status, "pending"),
        gt(toolApproval.expiresAt, now)
      )
    )
    .limit(1);
  if (existing.length > 0) {
    return { decision: "block", requestId: existing[0].id, created: false };
  }

  const ttlMs = input.ttlMs ?? DEFAULT_CONFIRM_TTL_MS;
  const [inserted] = await db
    .insert(toolApproval)
    .values({
      agentId: input.agentId,
      requesterId: input.requesterId,
      sessionKey: input.sessionKey,
      toolName: input.toolName,
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
  if (row.status !== "pending") return { ok: false, reason: "not_pending" };

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

/** Flip overdue pending requests to `expired`. Returns the count flipped. */
export async function expireStale(now?: Date): Promise<number> {
  const at = now ?? new Date();
  const expired = await db
    .update(toolApproval)
    .set({ status: "expired" })
    .where(and(eq(toolApproval.status, "pending"), lt(toolApproval.expiresAt, at)))
    .returning({ id: toolApproval.id });
  return expired.length;
}
