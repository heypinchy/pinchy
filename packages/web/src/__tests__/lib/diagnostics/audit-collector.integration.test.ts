// Integration test for fetchAuditEntriesForSession against a real Postgres DB.
// Verifies that resource-keyed rows come back stripped of HMAC + integrity
// fields so they can be safely embedded in a diagnostics bundle.

import { describe, it, expect } from "vitest";
import { appendAuditLog } from "@/lib/audit";
import { fetchAuditEntriesForSession } from "@/lib/diagnostics/audit-collector";

describe("fetchAuditEntriesForSession (integration)", () => {
  it("returns entries matching the given sessionKey as resource", async () => {
    const agentId = "agt_test_1";
    const sessionKey = `agent:${agentId}:direct:user1`;

    await appendAuditLog({
      actorType: "user",
      actorId: "user1",
      eventType: "tool.pinchy_ls",
      resource: sessionKey,
      detail: { agentId },
      outcome: "success",
    });
    await appendAuditLog({
      actorType: "user",
      actorId: "user1",
      eventType: "tool.pinchy_read",
      resource: sessionKey,
      detail: { agentId, path: "/x" },
      outcome: "success",
    });

    const rows = await fetchAuditEntriesForSession(agentId, sessionKey);
    expect(rows).toHaveLength(2);

    const row = rows[0] as Record<string, unknown>;
    expect(row.eventType).toMatch(/^tool\./);
    expect(row.actorType).toBe("user");
    expect(row.outcome).toBe("success");
    expect(row.resource).toBe(sessionKey);
    // HMAC + integrity fields must not leak into the bundle.
    expect(row).not.toHaveProperty("rowHmac");
    expect(row).not.toHaveProperty("prevRowHash");
  });

  it("does not include rows for other sessions or other agents", async () => {
    const agentId = "agt_test_2";
    const sessionKey = `agent:${agentId}:direct:user2`;
    const otherSessionKey = `agent:agt_test_other:direct:user2`;

    await appendAuditLog({
      actorType: "user",
      actorId: "user2",
      eventType: "tool.t",
      resource: sessionKey,
      detail: {},
      outcome: "success",
    });
    await appendAuditLog({
      actorType: "user",
      actorId: "user2",
      eventType: "tool.t",
      resource: otherSessionKey,
      detail: {},
      outcome: "success",
    });

    const rows = await fetchAuditEntriesForSession(agentId, sessionKey);
    expect(rows).toHaveLength(1);
    expect((rows[0] as Record<string, unknown>).resource).toBe(sessionKey);
  });

  it("returns an empty array when no rows match", async () => {
    const rows = await fetchAuditEntriesForSession("agt_nope", "agent:agt_nope:direct:nobody");
    expect(rows).toEqual([]);
  });
});
