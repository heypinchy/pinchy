/**
 * Gate decision service — exercised against a real PostgreSQL (no @/db mock)
 * so the consume-once / fail-closed guarantees are proven against actual SQL
 * semantics (FOR UPDATE SKIP LOCKED), not a faked query builder.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, agents, toolApproval } from "@/db/schema";
import { decideGate, resolveDecision, expireStale } from "./service";

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

  it("changed args produce a different digest → a new confirmation", async () => {
    const r = await decideGate(base());
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
    const other = await decideGate({ ...base(), argsDigest: "digest-2" });
    expect(other.decision).toBe("block");
    expect(other.requestId).not.toBe(r.requestId);
  });

  it("fails closed on an expired approved ticket (does not consume it)", async () => {
    const r = await decideGate({ ...base(), ttlMs: -1000 });
    await resolveDecision({ id: r.requestId, approverId: requesterId, decision: "approve" });
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

  it("expireStale flips overdue pending requests to expired", async () => {
    const r = await decideGate({ ...base(), ttlMs: -1000 });
    const n = await expireStale();
    expect(n).toBeGreaterThanOrEqual(1);
    const [row] = await db.select().from(toolApproval).where(eq(toolApproval.id, r.requestId));
    expect(row.status).toBe("expired");
  });
});
