// Integration test for fetchAuditEntriesForSession against a real Postgres DB.
//
// Verifies the real production audit row shape: every chat/tool/agent event
// stamps `resource = "agent:<agentId>"`, and the collector additionally
// filters on `actorId` so one user's diagnostics bundle never leaks another
// user's audit rows for the same agent.
//
// Also asserts that HMAC + integrity fields are stripped before returning so
// they can't leak into a downloadable bundle.

import { describe, it, expect } from "vitest";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { auditLog } from "@/db/schema";
import { fetchAuditEntriesForSession } from "@/lib/diagnostics/audit-collector";

// Direct-write helper so we can pin specific timestamps without relying on
// appendAuditLog's internal `new Date()`. The HMAC column is `notNull` so we
// fill it with a placeholder — audit-collector doesn't read or validate it.
async function insertAuditAt(opts: {
  agentId: string;
  userId: string;
  eventType: string;
  timestamp: Date;
}) {
  await db.insert(auditLog).values({
    actorType: "user",
    actorId: opts.userId,
    eventType: opts.eventType,
    resource: `agent:${opts.agentId}`,
    detail: { agentId: opts.agentId },
    outcome: "success",
    rowHmac: "test-placeholder-hmac",
    timestamp: opts.timestamp,
  });
}

describe("fetchAuditEntriesForSession (integration)", () => {
  it("returns entries matching agent:<agentId> resource and the given actorId", async () => {
    const agentId = "agt_test_1";
    const userId = "user1";

    await appendAuditLog({
      actorType: "user",
      actorId: userId,
      eventType: "tool.pinchy_ls",
      resource: `agent:${agentId}`,
      detail: { agentId },
      outcome: "success",
    });
    await appendAuditLog({
      actorType: "user",
      actorId: userId,
      eventType: "tool.pinchy_read",
      resource: `agent:${agentId}`,
      detail: { agentId, path: "/x" },
      outcome: "success",
    });

    const rows = await fetchAuditEntriesForSession(agentId, userId);
    expect(rows).toHaveLength(2);

    const row = rows[0] as Record<string, unknown>;
    expect(row.eventType).toMatch(/^tool\./);
    expect(row.actorType).toBe("user");
    expect(row.outcome).toBe("success");
    expect(row.resource).toBe(`agent:${agentId}`);
    expect(row.actorId).toBe(userId);
    // HMAC + integrity fields must not leak into the bundle.
    expect(row).not.toHaveProperty("rowHmac");
    expect(row).not.toHaveProperty("prevRowHash");
  });

  it("does not leak rows for the same agent but a different actorId", async () => {
    const agentId = "agt_test_2";
    const userId = "user2";
    const otherUserId = "user2_other";

    await appendAuditLog({
      actorType: "user",
      actorId: userId,
      eventType: "tool.t",
      resource: `agent:${agentId}`,
      detail: {},
      outcome: "success",
    });
    await appendAuditLog({
      actorType: "user",
      actorId: otherUserId,
      eventType: "tool.t",
      resource: `agent:${agentId}`,
      detail: {},
      outcome: "success",
    });

    const rows = await fetchAuditEntriesForSession(agentId, userId);
    expect(rows).toHaveLength(1);
    const row = rows[0] as Record<string, unknown>;
    expect(row.actorId).toBe(userId);
  });

  it("does not include rows for a different agent", async () => {
    const agentId = "agt_test_3";
    const otherAgentId = "agt_test_3_other";
    const userId = "user3";

    await appendAuditLog({
      actorType: "user",
      actorId: userId,
      eventType: "tool.t",
      resource: `agent:${agentId}`,
      detail: {},
      outcome: "success",
    });
    await appendAuditLog({
      actorType: "user",
      actorId: userId,
      eventType: "tool.t",
      resource: `agent:${otherAgentId}`,
      detail: {},
      outcome: "success",
    });

    const rows = await fetchAuditEntriesForSession(agentId, userId);
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).resource).toBe(`agent:${agentId}`);
  });

  it("returns an empty array when no rows match", async () => {
    const rows = await fetchAuditEntriesForSession("agt_nope", "user_nobody");
    expect(rows).toEqual([]);
  });

  it("filters by an optional [from, to] time range when provided", async () => {
    const agentId = "agt_range";
    const userId = "user_range";
    const t0 = new Date("2026-01-01T10:00:00Z");
    const t1 = new Date("2026-01-01T11:00:00Z");
    const t2 = new Date("2026-01-01T12:00:00Z");
    const t3 = new Date("2026-01-01T13:00:00Z");

    await insertAuditAt({ agentId, userId, eventType: "tool.before", timestamp: t0 });
    await insertAuditAt({ agentId, userId, eventType: "tool.from_edge", timestamp: t1 });
    await insertAuditAt({ agentId, userId, eventType: "tool.middle", timestamp: t2 });
    await insertAuditAt({ agentId, userId, eventType: "tool.after", timestamp: t3 });

    // Inclusive range [t1, t2] should pick exactly the two middle rows.
    const rows = await fetchAuditEntriesForSession(agentId, userId, { from: t1, to: t2 });
    expect(rows.map((r) => r.eventType)).toEqual(["tool.from_edge", "tool.middle"]);
  });

  it("returns all matching rows when no range is provided (back-compat)", async () => {
    const agentId = "agt_norange";
    const userId = "user_norange";
    await insertAuditAt({
      agentId,
      userId,
      eventType: "tool.early",
      timestamp: new Date("2020-01-01T00:00:00Z"),
    });
    await insertAuditAt({
      agentId,
      userId,
      eventType: "tool.late",
      timestamp: new Date("2030-01-01T00:00:00Z"),
    });
    const rows = await fetchAuditEntriesForSession(agentId, userId);
    expect(rows).toHaveLength(2);
  });
});
