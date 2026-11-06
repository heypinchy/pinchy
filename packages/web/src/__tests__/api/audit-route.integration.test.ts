// Real-DB integration test for GET /api/audit's total-count optimization
// (part of #1076): total is only (re)computed on page 1, and an unfiltered
// page-1 request reads pg_class.reltuples instead of an exact count(*).
//
// The unit tests in audit-route.test.ts mock db.select/db.execute entirely,
// which proves the branching logic but not that the raw
// `SELECT reltuples::bigint AS estimate FROM pg_class WHERE oid = ...`
// actually runs against real Postgres — a typo in that literal SQL string
// would still pass every mocked test. This is that guardrail.
//
// Only auth is mocked (Better Auth cookies on a NextRequest are not the thing
// under test); the DB reads are real.

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn() };
});

import { getSession } from "@/lib/auth";
import { appendAuditLog } from "@/lib/audit";
import { GET } from "@/app/api/audit/route";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { KB_INDEX_SCHEDULER_ACTOR } from "@/lib/knowledge/reindex-audit";
import { makeNextRequest } from "@/test-helpers/route";

function asAdmin() {
  vi.mocked(getSession).mockResolvedValue({
    user: { id: "admin-1", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
}

async function appendLoginRow(actorId: string) {
  await appendAuditLog({
    actorType: "user",
    actorId,
    eventType: "auth.login",
    resource: `user:${actorId}`,
    outcome: "success",
  });
}

async function appendConfigChangedRow(actorId: string) {
  await appendAuditLog({
    actorType: "user",
    actorId,
    eventType: "config.changed",
    detail: { key: "test" },
    outcome: "success",
  });
}

async function get(url: string) {
  const response = await GET(makeNextRequest(url));
  return { status: response.status, body: await response.json() };
}

describe("GET /api/audit (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asAdmin();
  });

  it("computes a real total (via pg_class.reltuples) on an unfiltered page-1 request", async () => {
    await appendLoginRow("user-1");
    await appendLoginRow("user-2");
    await appendLoginRow("user-3");

    const { status, body } = await get("http://localhost/api/audit");

    expect(status).toBe(200);
    expect(body.entries).toHaveLength(3);
    // reltuples is a planner ESTIMATE, refreshed by ANALYZE — on a table this
    // small and this freshly written to, it can legitimately read anywhere
    // from 0 up. The floor against the page's own entry count is exactly
    // what keeps this assertion true regardless of autovacuum timing: the
    // route must never report fewer than what it is already returning.
    expect(body.total).toBeGreaterThanOrEqual(3);
  });

  it("omits total on page 2 — no recomputation past page 1", async () => {
    await appendLoginRow("user-1");
    await appendLoginRow("user-2");

    const { status, body } = await get("http://localhost/api/audit?page=2&limit=1");

    expect(status).toBe(200);
    expect("total" in body).toBe(false);
  });

  it("computes an exact count for a filtered page-1 request", async () => {
    await appendLoginRow("user-1");
    await appendConfigChangedRow("user-2");

    const { status, body } = await get("http://localhost/api/audit?eventType=auth.login");

    expect(status).toBe(200);
    expect(body.entries).toHaveLength(1);
    expect(body.total).toBe(1);
  });
});

// #1271: the Actor column showed `711ed709…` for an agent's retrieval.query
// and `kb-index…` for the scheduled reindex, because the only actor join was
// against `users`. Agent and system actors are named on the read side; the
// row itself keeps the raw id it was written with.
describe("GET /api/audit actor names for non-user actors (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asAdmin();
  });

  async function makeAgent(name: string) {
    const [agent] = await db
      .insert(agents)
      .values({ name, model: "test-model", greetingMessage: "Hi" })
      .returning();
    return agent;
  }

  async function appendRetrievalRow(agent: { id: string; name: string }) {
    await appendAuditLog({
      actorType: "agent",
      actorId: agent.id,
      eventType: "retrieval.query",
      resource: `agent:${agent.id}`,
      detail: {
        agent: { id: agent.id, name: agent.name },
        queryHash: "h",
        resultCount: 0,
        returnedDocumentIds: [],
      },
      outcome: "success",
    });
  }

  it("names an agent actor after the agent", async () => {
    const agent = await makeAgent("Musterbau Wissen");
    await appendRetrievalRow(agent);

    const { body } = await get("http://localhost/api/audit");

    expect(body.entries[0].actorType).toBe("agent");
    expect(body.entries[0].actorId).toBe(agent.id);
    expect(body.entries[0].actorName).toBe("Musterbau Wissen");
    expect(body.entries[0].actorDeleted).toBe(false);
  });

  it("keeps a deleted agent's name and marks it deleted", async () => {
    const agent = await makeAgent("Old Archivist");
    await appendRetrievalRow(agent);
    await db.update(agents).set({ deletedAt: new Date() }).where(eq(agents.id, agent.id));

    const { body } = await get("http://localhost/api/audit");

    expect(body.entries[0].actorName).toBe("Old Archivist");
    expect(body.entries[0].actorDeleted).toBe(true);
  });

  it("gives a system actor a readable label", async () => {
    await appendAuditLog({
      actorType: "system",
      actorId: KB_INDEX_SCHEDULER_ACTOR,
      eventType: "knowledge.reindex",
      detail: { agent: { id: "a1", name: "Archivist" }, pathCount: 1, trigger: "scheduled" },
      outcome: "success",
    });

    const { body } = await get("http://localhost/api/audit");

    expect(body.entries[0].actorId).toBe(KB_INDEX_SCHEDULER_ACTOR);
    expect(body.entries[0].actorName).toBe("Scheduled reindex");
  });
});
