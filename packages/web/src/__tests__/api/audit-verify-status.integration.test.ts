// Real-DB integration test for GET /api/audit/verify/status (#699).
//
// The endpoint surfaces the periodic verify job's health to operators without
// tailing stderr. Its whole point is that the signal is DURABLE — read back
// out of `audit_verify_state` / `audit_log` rather than from a process-local
// counter that a restart silently zeroes. A mocked-db unit test could not
// prove that, so the coverage lives here: the real job writes the checkpoint,
// the real route reads it back.
//
// Only auth is mocked (Better Auth cookies on a NextRequest are not the thing
// under test); the DB reads, the sweep, and the chain verification are real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq, sql } from "drizzle-orm";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn() };
});

import { db } from "@/db";
import { auditLog, auditVerifyState } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { getSession } from "@/lib/auth";
import { sweepAuditVerify } from "@/server/audit-verify-job";
import { GET } from "@/app/api/audit/verify/status/route";
import { routeContext } from "@/test-helpers/route";

function asAdmin() {
  vi.mocked(getSession).mockResolvedValue({
    user: { id: "admin-1", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
}

async function getStatus() {
  const request = new NextRequest("http://localhost:7777/api/audit/verify/status");
  const response = await GET(request, routeContext());
  return { status: response.status, body: await response.json() };
}

async function appendRow(actorId: string) {
  await appendAuditLog({
    actorType: "user",
    actorId,
    eventType: "auth.login",
    resource: `user:${actorId}`,
    outcome: "success",
  });
}

// Delete a row past the append-only trigger, modeling an attacker with direct
// DB access. Deleting (not UPDATE-ing prev_hmac) is what produces a genuine
// chain break — see audit-verify-job.integration.test.ts for the full
// rationale.
async function deleteRowPastTrigger(id: number) {
  await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER no_delete`);
  try {
    await db.delete(auditLog).where(eq(auditLog.id, id));
  } finally {
    await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER no_delete`);
  }
}

describe("GET /api/audit/verify/status (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    asAdmin();
  });

  it("returns 401 when unauthenticated", async () => {
    vi.mocked(getSession).mockResolvedValue(
      null as unknown as Awaited<ReturnType<typeof getSession>>
    );

    const { status } = await getStatus();
    expect(status).toBe(401);
  });

  it("returns 403 for a non-admin session — a tamper alarm is not member-readable", async () => {
    vi.mocked(getSession).mockResolvedValue({
      user: { id: "member-1", role: "member" },
    } as unknown as Awaited<ReturnType<typeof getSession>>);

    const { status } = await getStatus();
    expect(status).toBe(403);
  });

  it("reports never_run before the job has ever checkpointed", async () => {
    const { status, body } = await getStatus();

    expect(status).toBe(200);
    expect(body).toEqual({
      lastStatus: "never_run",
      lastVerifiedId: 0,
      lastRunAt: null,
      lastViolationAt: null,
    });
  });

  it("reports ok with the checkpoint the job actually wrote after a clean sweep", async () => {
    await appendRow("user-1");
    await appendRow("user-2");

    const before = Date.now();
    const sweep = await sweepAuditVerify();
    expect(sweep.valid).toBe(true);

    const { status, body } = await getStatus();

    expect(status).toBe(200);
    expect(body.lastStatus).toBe("ok");
    // The job folds its own audit.integrity_check report row into the
    // checkpoint, so lastVerifiedId is the report row's id.
    const [checkpoint] = await db.select().from(auditVerifyState).where(eq(auditVerifyState.id, 1));
    expect(body.lastVerifiedId).toBe(checkpoint.lastVerifiedId);
    expect(new Date(body.lastRunAt).getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(body.lastViolationAt).toBeNull();
  });

  it("reports the durable violation from a checkpoint written before this process started", async () => {
    // The upgrade / restart case the endpoint exists for: the job detected a
    // violation in an earlier process, wrote it to audit_verify_state, and the
    // container was restarted. Any in-process counter is 0 now — the alarm
    // must still be visible, so it is read back out of the DB.
    await db.insert(auditVerifyState).values({
      id: 1,
      lastVerifiedId: 42,
      lastVerifiedHmac: "hmac-42",
      lastStatus: "violation",
    });

    const { status, body } = await getStatus();

    expect(status).toBe(200);
    expect(body.lastStatus).toBe("violation");
    expect(body.lastVerifiedId).toBe(42);
    expect(body.lastRunAt).not.toBeNull();
  });

  it("keeps a detected violation visible after a later clean sweep flips lastStatus back to ok", async () => {
    // lastStatus describes the LAST sweep only. The job advances its
    // checkpoint past a tampered window on purpose (no alarm-spam), so the
    // next sweep over fresh, intact rows legitimately writes "ok" — and the
    // tamper evidence would silently disappear from this endpoint. The
    // audit.integrity_check failure row is the durable, never-cleared record,
    // so lastViolationAt is what answers "has this log ever been tampered
    // with".
    await appendRow("user-1");
    await appendRow("user-2");
    await appendRow("user-3");
    const [row2] = await db
      .select({ id: auditLog.id })
      .from(auditLog)
      .where(eq(auditLog.actorId, "user-2"));
    await deleteRowPastTrigger(row2.id);

    const violating = await sweepAuditVerify();
    expect(violating.valid).toBe(false);

    const alarmed = await getStatus();
    expect(alarmed.body.lastStatus).toBe("violation");
    expect(alarmed.body.lastViolationAt).not.toBeNull();

    // A later sweep over intact rows reports ok...
    await appendRow("user-4");
    const clean = await sweepAuditVerify();
    expect(clean.valid).toBe(true);

    const after = await getStatus();
    expect(after.body.lastStatus).toBe("ok");
    // ...but the tamper evidence is still there.
    expect(after.body.lastViolationAt).toBe(alarmed.body.lastViolationAt);
  });

  it("treats a checkpoint row with no recorded status as never_run rather than crashing", async () => {
    // last_status is nullable in the schema; the job always writes it, but a
    // hand-written or partially-migrated row must not take the endpoint down.
    await db.insert(auditVerifyState).values({ id: 1, lastVerifiedId: 7 });

    const { status, body } = await getStatus();

    expect(status).toBe(200);
    expect(body.lastStatus).toBe("never_run");
    expect(body.lastVerifiedId).toBe(7);
  });
});
