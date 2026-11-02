// Real-DB tests for POST /api/users/:id/acknowledge-origin ("Mark as known").
//
// Settings → Users flags accounts neither the setup wizard nor an invite
// explains (lib/user-provenance.ts). The rule over-reports — a demoted setup
// admin who never sent an invite, an invite deleted after its claim — so an
// admin needs a way to say "I know this one". The acknowledgement is stored as
// a `user.origin_acknowledged` audit row and the provenance query reads it, so
// these tests run the route, the audit chain and the query for real. Only the
// session is faked.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn() };
});

import { db } from "@/db";
import { users, auditLog } from "@/db/schema";
import { getSession } from "@/lib/auth";
import { findUnknownOriginUsers } from "@/lib/user-provenance";
import { mockSession } from "@/test-helpers/auth";
import { POST } from "@/app/api/users/[userId]/acknowledge-origin/route";

let seq = 0;
async function insertUser(name: string, role: "admin" | "member", minute: number) {
  seq++;
  const [row] = await db
    .insert(users)
    .values({
      name,
      email: `${name.toLowerCase().replace(/\s+/g, "-")}-${seq}@test.local`,
      role,
      createdAt: new Date(Date.UTC(2026, 5, 1, 9, minute)),
    })
    .returning();
  return row;
}

function signInAs(user: { id: string; name: string; email: string; role: string }) {
  vi.mocked(getSession).mockResolvedValue(
    mockSession({ user: { id: user.id, name: user.name, email: user.email, role: user.role } })
  );
}

function acknowledge(userId: string, body: unknown = {}) {
  return POST(
    new NextRequest(`http://localhost/api/users/${userId}/acknowledge-origin`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ userId }) }
  );
}

async function acknowledgementRows(userId: string) {
  return db
    .select()
    .from(auditLog)
    .where(
      and(
        eq(auditLog.eventType, "user.origin_acknowledged"),
        eq(auditLog.resource, `user:${userId}`)
      )
    );
}

describe("POST /api/users/:id/acknowledge-origin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("marks a flagged account as known and records who did it", async () => {
    const admin = await insertUser("Setup Admin", "admin", 0);
    const stranger = await insertUser("Stranger", "member", 1);
    signInAs(admin);
    expect((await findUnknownOriginUsers()).map((u) => u.id)).toEqual([stranger.id]);

    const res = await acknowledge(stranger.id);

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true });
    expect(await findUnknownOriginUsers()).toEqual([]);

    const rows = await acknowledgementRows(stranger.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ actorType: "user", outcome: "success" });
    // The subject's id is in `resource`, which the provenance check reads; the
    // detail snapshots the name beside it (see the own-account test for why
    // the id is not repeated there).
    expect(rows[0].resource).toBe(`user:${stranger.id}`);
    expect(rows[0].detail).toEqual({ user: { name: "Stranger" } });
    // #824: the acting admin is carried by the (pseudonymized) actorId alone —
    // never as a raw id in the immutable row. And no email anywhere.
    expect(rows[0].actorId).not.toBe(admin.id);
    expect(JSON.stringify(rows[0])).not.toContain(admin.id);
    expect(JSON.stringify(rows[0])).not.toContain(stranger.email);
  });

  it("lets an admin clear the flag on their own account", async () => {
    // A self-registered account that was promoted, or a demoted-then-promoted
    // setup admin, may be the only admin left. Nobody else can vouch for them.
    const earlier = await insertUser("First Admin", "admin", 0);
    const me = await insertUser("Promoted Admin", "admin", 1);
    signInAs(me);
    expect((await findUnknownOriginUsers()).map((u) => u.id)).toEqual([me.id]);

    const res = await acknowledge(me.id);

    expect(res.status).toBe(200);
    expect(await findUnknownOriginUsers()).toEqual([]);
    expect(earlier.id).not.toBe(me.id);

    // #824: here the subject IS the actor. A `user.id` in the detail would put
    // the acting admin's raw id into the immutable, HMAC-chained detail, where
    // crypto-erasure of the (pseudonymized) actorId can never reach it.
    const [row] = await acknowledgementRows(me.id);
    expect(row.actorId).not.toBe(me.id);
    expect(JSON.stringify(row.detail)).not.toContain(me.id);
    expect(row.detail).toEqual({ user: { name: "Promoted Admin" } });
  });

  it("refuses a member, without writing anything", async () => {
    await insertUser("Setup Admin", "admin", 0);
    const member = await insertUser("Member", "member", 1);
    signInAs(member);

    const res = await acknowledge(member.id);

    expect(res.status).toBe(403);
    expect(await acknowledgementRows(member.id)).toHaveLength(0);
  });

  it("answers 404 for an account that does not exist, without writing anything", async () => {
    const admin = await insertUser("Setup Admin", "admin", 0);
    signInAs(admin);

    const res = await acknowledge("no-such-user");

    expect(res.status).toBe(404);
    expect(await acknowledgementRows("no-such-user")).toHaveLength(0);
  });

  it("rejects a body with fields the route does not take", async () => {
    const admin = await insertUser("Setup Admin", "admin", 0);
    const stranger = await insertUser("Stranger", "member", 1);
    signInAs(admin);

    const res = await acknowledge(stranger.id, { reason: "trust me" });

    expect(res.status).toBe(400);
    expect(await acknowledgementRows(stranger.id)).toHaveLength(0);
  });
});
