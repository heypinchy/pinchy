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
