// Real-DB integration tests for the tool-approval expiry + retention sweep.
import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";

import { db } from "@/db";
import { users, agents, toolApproval, auditLog } from "@/db/schema";
import { sweepApprovals, TERMINAL_RETENTION_DAYS } from "@/server/approval-sweep";

async function seedUser() {
  const [row] = await db
    .insert(users)
    .values({
      name: "Sweep User",
      email: `sweep-${Math.random().toString(36).slice(2)}@example.com`,
      emailVerified: true,
      role: "admin",
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
      greetingMessage: "Hi",
      ownerId,
    })
    .returning();
  return row;
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);

describe("sweepApprovals", () => {
  it("flips overdue pending rows to expired, one approval.expired audit row each with the sweepId", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const base = {
      agentId: agent.id,
      requesterId: user.id,
      sessionKey: `agent:${agent.id}:direct:${user.id}`,
      toolName: "odoo_write",
      tier: "confirm" as const,
      status: "pending" as const,
    };
    const [overdue] = await db
      .insert(toolApproval)
      .values({ ...base, argsDigest: "d-overdue", expiresAt: new Date(Date.now() - 1000) })
      .returning();
    const [live] = await db
      .insert(toolApproval)
      .values({ ...base, argsDigest: "d-live", expiresAt: new Date(Date.now() + 60_000) })
      .returning();

    const res = await sweepApprovals();
    expect(res.expired).toBe(1);
    expect(res.sweepId).toMatch(/[0-9a-f-]{36}/);

    const [overdueRow] = await db
      .select()
      .from(toolApproval)
      .where(eq(toolApproval.id, overdue.id));
    expect(overdueRow.status).toBe("expired");
    const [liveRow] = await db.select().from(toolApproval).where(eq(toolApproval.id, live.id));
    expect(liveRow.status).toBe("pending");

    const expiredAudit = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "approval.expired"));
    expect(expiredAudit).toHaveLength(1);
    expect(expiredAudit[0].resource).toBe(`approval:${overdue.id}`);
    const detail = expiredAudit[0].detail as {
      sweepId: string;
      toolName: string;
      agent: { id: string; name: string | null };
      requester: { id: string; name: string | null };
    };
    expect(detail.sweepId).toBe(res.sweepId);
    expect(detail.toolName).toBe("odoo_write");
    expect(detail.agent).toEqual({ id: agent.id, name: "Smithers" });
    expect(detail.requester).toEqual({ id: user.id, name: "Sweep User" });
  });

  it("deletes settled rows past the retention window, one summary approval.gc audit row", async () => {
    const user = await seedUser();
    const agent = await seedAgent(user.id);
    const base = {
      agentId: agent.id,
      requesterId: user.id,
      sessionKey: `agent:${agent.id}:direct:${user.id}`,
      toolName: "odoo_write",
      tier: "confirm" as const,
      expiresAt: daysAgo(40),
    };
    await db.insert(toolApproval).values([
      // Settled + past the window → swept.
      { ...base, argsDigest: "d1", status: "consumed", createdAt: daysAgo(40) },
      { ...base, argsDigest: "d2", status: "expired", createdAt: daysAgo(40) },
      // Approved-but-never-consumed is a dead grant past the window → swept.
      { ...base, argsDigest: "d3", status: "approved", createdAt: daysAgo(40) },
      // Settled but within the window → kept.
      { ...base, argsDigest: "d4", status: "denied", createdAt: daysAgo(5) },
    ]);

    const res = await sweepApprovals();
    expect(res.deleted).toBe(3);

    const remaining = await db.select().from(toolApproval);
    expect(remaining).toHaveLength(1);
    expect(remaining[0].argsDigest).toBe("d4");

    const gcRows = await db.select().from(auditLog).where(eq(auditLog.eventType, "approval.gc"));
    expect(gcRows).toHaveLength(1);
    expect(gcRows[0].detail).toMatchObject({
      swept: 3,
      retentionDays: TERMINAL_RETENTION_DAYS,
      sweepId: res.sweepId,
    });
  });

  it("is a no-op (no audit rows) when nothing is eligible", async () => {
    const res = await sweepApprovals();
    expect(res.expired).toBe(0);
    expect(res.deleted).toBe(0);
    for (const eventType of ["approval.expired", "approval.gc"] as const) {
      expect(await db.select().from(auditLog).where(eq(auditLog.eventType, eventType))).toEqual([]);
    }
  });
});
