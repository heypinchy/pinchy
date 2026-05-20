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
import { fetchAuditEntriesForSession } from "@/lib/diagnostics/audit-collector";

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
});
