/**
 * Gate decision service — exercised against a real PostgreSQL (no @/db mock)
 * so the consume-once / fail-closed guarantees are proven against actual SQL
 * semantics (FOR UPDATE SKIP LOCKED), not a faked query builder.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, agents, toolApproval } from "@/db/schema";
import { decideGate, resolveDecision, expireStale, MAX_PENDING_PER_REQUESTER } from "./service";

async function seedUser(overrides?: Partial<typeof users.$inferInsert>) {
  const [row] = await db
    .insert(users)
    .values({
      name: "Test User",
      email: `u${Math.round(performance.now() * 1000)}@example.com`,
      emailVerified: true,
      role: "admin",
      ...overrides,
    })
    .returning();
  return row;
}

async function seedAgent(ownerId: string) {
  const [row] = await db
    .insert(agents)
    .values({
      name: "Smithers",
      model: "anthropic/claude-haiku-4-5-20251001",
      greetingMessage: "Hello!",
      ownerId,
    })
    .returning();
  return row;
}

describe("approvals gate decision service", () => {
  let agentId: string;
  let requesterId: string;
  const base = () => ({
    agentId,
    requesterId,
    sessionKey: "agent:a:direct:u",
    toolName: "odoo_write",
    argsDigest: "digest-1",
  });

  beforeEach(async () => {
    const u = await seedUser();
    requesterId = u.id;
    const a = await seedAgent(u.id);
    agentId = a.id;
  });

  it("blocks and creates a pending confirm request when no ticket exists", async () => {
    const r = await decideGate(base());
    expect(r.decision).toBe("block");
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("pending");
    expect(row.tier).toBe("confirm");
    expect(row.expiresAt.getTime()).toBeGreaterThan(Date.now());
  });

  it("reuses the same pending request on re-issue (no duplicate rows)", async () => {
    const r1 = await decideGate(base());
    const r2 = await decideGate(base());
    expect(r2.requestId).toBe(r1.requestId);
    expect(await db.select().from(toolApproval)).toHaveLength(1);
  });

  it("allows and consumes exactly once after approval, then re-gates", async () => {
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });

    const allow = await decideGate(base());
    expect(allow.decision).toBe("allow");
    expect(allow.requestId).toBe(r.requestId);
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("consumed");
    expect(row.consumedAt).not.toBeNull();

    // Consumed ticket cannot be reused — the next call is gated afresh.
    const again = await decideGate(base());
    expect(again.decision).toBe("block");
    expect(again.requestId).not.toBe(r.requestId);
  });

  it("an approval for one tool is not consumable by a different tool with the same digest", async () => {
    // Two gated tools can legitimately receive identical params (e.g. the
    // odoo record-action family all take `{ target: <ref> }`), so the digest
    // alone must not be the binding — "one confirmation, one action" includes
    // the tool name.
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });

    const cross = await decideGate({ ...base(), toolName: "odoo_unlink" });
    expect(cross.decision).toBe("block");
    const [grant] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(grant.status).toBe("approved");

    // The original tool still consumes its own grant.
    const own = await decideGate(base());
    expect(own.decision).toBe("allow");
    expect(own.requestId).toBe(r.requestId);
  });

  it("pending requests are tool-specific even with identical args", async () => {
    const a = await decideGate(base());
    const b = await decideGate({ ...base(), toolName: "odoo_unlink" });
    expect(b.requestId).not.toBe(a.requestId);
    expect(await db.select().from(toolApproval)).toHaveLength(2);
  });

  it("changed args produce a different digest → a new confirmation", async () => {
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
    const other = await decideGate({ ...base(), argsDigest: "digest-2" });
    expect(other.decision).toBe("block");
    expect(other.requestId).not.toBe(r.requestId);
  });

  it("fails closed on an expired approved ticket (does not consume it)", async () => {
    // Approve a live request, then let the grant expire before the agent
    // re-issues the call. (resolveDecision itself refuses already-expired
    // requests — see the not_pending test below — so expiry is injected
    // after the approval here.)
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
    await db
      .update(toolApproval)
      .set({ expiresAt: new Date(Date.now() - 1000) })
      .where(eq(toolApproval.id, r.requestId));
    const res = await decideGate(base());
    expect(res.decision).toBe("block");
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("approved");
  });

  it("consumes at most one ticket under concurrent retries", async () => {
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
    const [a, b] = await Promise.all([decideGate(base()), decideGate(base())]);
    expect([a, b].filter((x) => x.decision === "allow")).toHaveLength(1);
  });

  it("resolveDecision forbids a non-requester under self-confirm", async () => {
    const r = await decideGate(base());
    const other = await seedUser();
    const res = await resolveDecision({
      id: r.requestId,
      approverId: other.id,
      decision: "approve",
      selfConfirmOnly: true,
    });
    expect(res).toEqual({ ok: false, reason: "forbidden" });
  });

  it("resolveDecision deny records reason + approver", async () => {
    const r = await decideGate(base());
    const res = await resolveDecision({
      id: r.requestId,
      approverId: requesterId,
      decision: "deny",
      reason: "not now",
    });
    expect(res.ok).toBe(true);
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("denied");
    expect(row.decisionReason).toBe("not now");
    expect(row.approverId).toBe(requesterId);
    expect(row.decidedAt).not.toBeNull();
  });

  it("resolveDecision reports not_found and not_pending", async () => {
    const nf = await resolveDecision({
      id: "00000000-0000-4000-8000-000000000000",
      approverId: requesterId,
      decision: "approve",
    });
    expect(nf).toEqual({ ok: false, reason: "not_found" });

    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
    const np = await resolveDecision({
      id: r.requestId,
      approverId: requesterId,
      decision: "approve",
    });
    expect(np).toEqual({ ok: false, reason: "not_pending" });
  });

  it("resolveDecision refuses an expired pending request (fail-closed, sweep owns the flip)", async () => {
    // Approving an expired request would produce a dead grant (consume checks
    // expires_at) plus a success toast — refuse it up front instead.
    const r = await decideGate({ ...base(), ttlMs: -1000 });
    const res = await resolveDecision({
      id: r.requestId,
      approverId: requesterId,
      decision: "approve",
    });
    expect(res).toEqual({ ok: false, reason: "not_pending" });
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("pending");
    expect(row.approverId).toBeNull();
  });

  // Each distinct argsDigest mints its own row, and the block reason is a
  // prompt, not a schranke: a model that retries with a changed argument opens
  // one confirmation per attempt. That lands twice — a wall of cards in the
  // requester's inbox now, and one approval.expired audit row per request at
  // the next sweep, each of which takes the audit log's single advisory lock
  // (AGENTS.md §"An audit row … needs a bound").
  it("stops opening new confirmations once the requester is at the pending cap", async () => {
    for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) {
      await decideGate({ ...base(), argsDigest: `digest-${i}` });
    }
    const over = await decideGate({ ...base(), argsDigest: "one-too-many" });

    expect(over.decision).toBe("block");
    expect(over.limited).toBe(true);
    expect(over.created).toBe(false);
    expect(await db.select().from(toolApproval)).toHaveLength(MAX_PENDING_PER_REQUESTER);
  });

  it("still spends an approved ticket while the requester is at the cap", async () => {
    // The cap is backpressure on OPENING confirmations. Refusing to consume a
    // ticket the user already approved would strand the action they said yes
    // to — the one outcome worse than the wall of cards.
    for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) {
      await decideGate({ ...base(), argsDigest: `digest-${i}` });
    }
    const first = await decideGate({ ...base(), argsDigest: "digest-0" });
    await resolveDecision({ id: first.requestId, approverId: requesterId, decision: "approve" });
    // Back to the cap: approving moved digest-0 out of `pending`.
    await decideGate({ ...base(), argsDigest: "refill" });

    const allow = await decideGate({ ...base(), argsDigest: "digest-0" });
    expect(allow.decision).toBe("allow");
  });

  it("counts the cap per requester, not per agent", async () => {
    // Two people sharing an agent must not exhaust each other's budget — the
    // same reason a grant is never shared across them.
    const other = await seedUser();
    for (let i = 0; i < MAX_PENDING_PER_REQUESTER; i++) {
      await decideGate({ ...base(), argsDigest: `digest-${i}` });
    }
    const theirs = await decideGate({
      ...base(),
      requesterId: other.id,
      argsDigest: "their-first",
    });
    expect(theirs.decision).toBe("block");
    expect(theirs.limited).toBeFalsy();
    expect(theirs.created).toBe(true);
  });

  it("expireStale flips overdue pending requests to expired and returns them", async () => {
    const r = await decideGate({ ...base(), ttlMs: -1000 });
    const flipped = await expireStale();
    expect(flipped.map((f) => f.id)).toContain(r.requestId);
    expect(flipped.find((f) => f.id === r.requestId)).toMatchObject({
      agentId,
      requesterId,
      toolName: "odoo_write",
      argsDigest: "digest-1",
    });
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("expired");
  });
});
