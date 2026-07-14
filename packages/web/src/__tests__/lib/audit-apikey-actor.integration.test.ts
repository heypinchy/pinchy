// Real-DB integration test for the `api_key` audit actor type (#572, Task 1.2).
//
// Agent-provisioning requests are authenticated by an API key, not a logged-in
// user — so their audit rows need a distinct actor type. A mocked test would
// prove nothing here: the whole point is that BOTH the Postgres `actor_type`
// enum AND the TypeScript `AuditLogBase.actorType` union accept "api_key"
// end-to-end. If the enum lacked the value, the INSERT inside appendAuditLog
// would throw ("invalid input value for enum actor_type"); if the union were
// too narrow, this file wouldn't type-check under `tsc`/`lint`.
//
// Provisioned by global-setup.ts (fresh migrated DB) and truncated between
// tests (setup.ts, audit_log is already in APPLICATION_TABLES). No mocks.

import { describe, it, expect } from "vitest";
import { eq } from "drizzle-orm";
import { appendAuditLog } from "@/lib/audit";
import { db } from "@/db";
import { auditLog } from "@/db/schema";

describe("api_key audit actor type (integration)", () => {
  it("persists an audit row with actorType 'api_key' and reads it back", async () => {
    await appendAuditLog({
      actorType: "api_key",
      actorId: "key-1",
      eventType: "agent.created",
      resource: "agent:a1",
      detail: { name: "X" },
      outcome: "success",
    });

    const rows = await db.select().from(auditLog).where(eq(auditLog.actorId, "key-1"));

    expect(rows).toHaveLength(1);
    expect(rows[0].actorType).toBe("api_key");
    expect(rows[0].eventType).toBe("agent.created");
    expect(rows[0].resource).toBe("agent:a1");
    expect(rows[0].outcome).toBe("success");
  });
});
