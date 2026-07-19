// Real-DB integration test for POST /api/internal/audit/tool-use.
//
// The unit test (internal-audit-tool-use.test.ts) mocks @/db AND appendAuditLog,
// so it only proves the route hands the lookup result to appendAuditLog — it
// exercises neither the `lower(id)` match nor appendAuditLog's real GDPR
// pseudonym substitution (resolveActorId in audit.ts). This test wires both
// against real Postgres:
//
//   1. Seed a user with a mixed-case users.id and a KNOWN audit_pseudonym.
//   2. Drive the route with the LOWERCASED id OpenClaw puts in the session key.
//   3. Assert the persisted audit_log row carries the user's PSEUDONYM.
//
// That end-to-end path only produces the pseudonym if canonicalizeUserId first
// restores the real case (so resolveActorId's case-sensitive `eq(users.id, ?)`
// matches). If canonicalizeUserId ever regresses to a case-sensitive match, the
// route would hand appendAuditLog the raw lowercased id, resolveActorId would
// find no user, and the row would carry the raw lowercased id instead of the
// pseudonym — which this test's first case asserts against.
//
// Uses a real PostgreSQL test database (provisioned by global-setup.ts and
// truncated between tests by setup.ts). Only the gateway-token check is stubbed;
// the db lookup and appendAuditLog write run for real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

vi.mock("@/lib/gateway-auth", () => ({
  validateGatewayToken: vi.fn().mockReturnValue(true),
}));

import { db } from "@/db";
import { users, auditLog } from "@/db/schema";
import { POST } from "@/app/api/internal/audit/tool-use/route";

// Better-Auth-style id: 32 chars, mixed case — this is the case OpenClaw's
// lowercased session key destroys.
const CANONICAL_USER_ID = "9Uy331nd8hFYbtm0ulwlztjwboimggn2";
// A fixed, recognizable pseudonym so the assertion doesn't depend on the random
// audit_pseudonym default.
const KNOWN_PSEUDONYM = "11111111-1111-4111-8111-111111111111";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost/api/internal/audit/tool-use", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer gw-token",
    },
    body: JSON.stringify(body),
  });
}

describe("POST /api/internal/audit/tool-use (real DB)", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await db.insert(users).values({
      id: CANONICAL_USER_ID,
      auditPseudonym: KNOWN_PSEUDONYM,
      name: "Case User",
      email: "case-user@example.com",
      emailVerified: true,
      role: "member",
    });
  });

  it("pseudonymizes a lowercased session-key user by canonicalizing the id first", async () => {
    const res = await POST(
      makeRequest({
        phase: "end",
        toolName: "browser",
        agentId: "agent-2",
        sessionKey: `agent:agent-2:direct:${CANONICAL_USER_ID.toLowerCase()}`,
        result: { ok: true },
      })
    );
    expect(res.status).toBe(200);

    const rows = await db
      .select({ actorType: auditLog.actorType, actorId: auditLog.actorId })
      .from(auditLog)
      .where(eq(auditLog.eventType, "tool.browser"));

    // The persisted actor is the user's pseudonym, not the raw lowercased id —
    // proof the id was canonicalized before resolveActorId's case-sensitive
    // lookup ran.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ actorType: "user", actorId: KNOWN_PSEUDONYM });
  });

  it("writes the raw lowercased id when no users row matches (no pseudonym available)", async () => {
    const res = await POST(
      makeRequest({
        phase: "end",
        toolName: "web",
        agentId: "agent-2",
        sessionKey: "agent:agent-2:direct:no-such-user-id",
        result: { ok: true },
      })
    );
    expect(res.status).toBe(200);

    const rows = await db
      .select({ actorType: auditLog.actorType, actorId: auditLog.actorId })
      .from(auditLog)
      .where(eq(auditLog.eventType, "tool.web"));

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ actorType: "user", actorId: "no-such-user-id" });
  });
});
