// Real-DB tests for account provenance (lib/user-provenance.ts).
//
// Until the client allowlist in lib/auth.ts, any client could self-register
// through Better Auth's `/sign-up/email`. Pinchy itself creates accounts in
// exactly two places: the setup wizard (the first admin) and a claimed invite
// (`invites.type = 'invite'`, `claimed_by_user_id`). An account that neither
// explains came in through the open endpoint, and an upgrade does nothing to
// it — password sign-in is allowlisted, so it keeps working. These tests pin
// the rule that finds such accounts, and the boot-time audit row that reports
// each one exactly once.

import { describe, it, expect } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { users, invites, auditLog } from "@/db/schema";
import { createInvite } from "@/lib/invites";
import { findUnknownOriginUsers, reportUnknownOriginUsers } from "@/lib/user-provenance";

let seq = 0;
async function insertUser(opts: {
  name: string;
  role?: "admin" | "member";
  createdAt: Date;
  banned?: boolean;
}) {
  seq++;
  const [row] = await db
    .insert(users)
    .values({
      name: opts.name,
      email: `${opts.name.toLowerCase().replace(/\s+/g, "-")}-${seq}@test.local`,
      role: opts.role ?? "member",
      banned: opts.banned ?? false,
      createdAt: opts.createdAt,
    })
    .returning();
  return row;
}

async function claimedInvite(
  createdBy: string,
  claimedBy: string,
  type: "invite" | "reset" = "invite"
) {
  const { tokenHash } = await createInvite({
    role: "member",
    type,
    createdBy,
  });
  await db
    .update(invites)
    .set({ claimedAt: new Date(), claimedByUserId: claimedBy })
    .where(eq(invites.tokenHash, tokenHash));
}

const t = (minute: number) => new Date(Date.UTC(2026, 5, 1, 9, minute));

describe("findUnknownOriginUsers", () => {
  it("flags neither the setup admin nor an invite-claimed user, and flags a user with neither", async () => {
    const admin = await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(0) });
    const invited = await insertUser({ name: "Invited Member", createdAt: t(1) });
    await claimedInvite(admin.id, invited.id);
    const stranger = await insertUser({ name: "Stranger", createdAt: t(2) });

    const flagged = await findUnknownOriginUsers();

    expect(flagged.map((u) => u.id)).toEqual([stranger.id]);
    expect(flagged[0]).toMatchObject({ name: "Stranger", role: "member", banned: false });
  });

  it("does not count a claimed password-reset invite as an account's origin", async () => {
    // A reset invite is issued for an account that already exists; claiming
    // one says nothing about where that account came from.
    const admin = await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(0) });
    const stranger = await insertUser({ name: "Reset Stranger", createdAt: t(1) });
    await claimedInvite(admin.id, stranger.id, "reset");

    const flagged = await findUnknownOriginUsers();

    expect(flagged.map((u) => u.id)).toEqual([stranger.id]);
  });

  it("still recognises the setup admin when a self-registration predates setup", async () => {
    // A fresh public instance accepted sign-ups before the wizard ran, so the
    // earliest account is not necessarily the setup admin. Setup is the first
    // account to become admin — sign-up only ever produced members.
    const early = await insertUser({ name: "Early Bird", createdAt: t(0) });
    const admin = await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(5) });

    const flagged = await findUnknownOriginUsers();

    expect(flagged.map((u) => u.id)).toEqual([early.id]);
    expect(flagged.map((u) => u.id)).not.toContain(admin.id);
  });

  it("does not flag an admin who claimed an admin invite, and flags an admin who didn't", async () => {
    const setup = await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(0) });
    const invitedAdmin = await insertUser({
      name: "Invited Admin",
      role: "admin",
      createdAt: t(1),
    });
    await claimedInvite(setup.id, invitedAdmin.id);
    const promoted = await insertUser({
      name: "Promoted Stranger",
      role: "admin",
      createdAt: t(2),
    });

    const flagged = await findUnknownOriginUsers();

    expect(flagged.map((u) => u.id)).toEqual([promoted.id]);
  });

  it("includes deactivated accounts, marked as banned", async () => {
    await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(0) });
    const gone = await insertUser({ name: "Already Deactivated", createdAt: t(1), banned: true });

    const flagged = await findUnknownOriginUsers();

    expect(flagged).toEqual([expect.objectContaining({ id: gone.id, banned: true })]);
  });

  it("returns nothing on an instance where every account is accounted for", async () => {
    const admin = await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(0) });
    const a = await insertUser({ name: "Member A", createdAt: t(1) });
    const b = await insertUser({ name: "Member B", createdAt: t(2) });
    await claimedInvite(admin.id, a.id);
    await claimedInvite(admin.id, b.id);

    expect(await findUnknownOriginUsers()).toEqual([]);
  });
});

describe("reportUnknownOriginUsers", () => {
  async function detectionRows() {
    return db.select().from(auditLog).where(eq(auditLog.eventType, "user.unknown_origin_detected"));
  }

  it("writes one system audit row per unknown-origin account, without the email", async () => {
    await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(0) });
    const stranger = await insertUser({ name: "Stranger", createdAt: t(1) });

    const written = await reportUnknownOriginUsers();

    expect(written).toBe(1);
    const rows = await detectionRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "system",
      actorId: "system",
      resource: `user:${stranger.id}`,
      outcome: "success",
    });
    expect(rows[0].detail).toMatchObject({
      user: { id: stranger.id, name: "Stranger" },
      role: "member",
    });
    expect(JSON.stringify(rows[0].detail)).not.toContain(stranger.email);
  });

  it("does not report the same account again on the next boot", async () => {
    await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(0) });
    await insertUser({ name: "Stranger", createdAt: t(1) });

    expect(await reportUnknownOriginUsers()).toBe(1);
    expect(await reportUnknownOriginUsers()).toBe(0);

    expect(await detectionRows()).toHaveLength(1);
  });

  it("reports an account it has not reported before, and only that one", async () => {
    await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(0) });
    const first = await insertUser({ name: "First Stranger", createdAt: t(1) });
    await reportUnknownOriginUsers();

    const second = await insertUser({ name: "Second Stranger", createdAt: t(2) });
    expect(await reportUnknownOriginUsers()).toBe(1);

    const rows = await detectionRows();
    expect(rows.map((r) => r.resource).sort()).toEqual(
      [`user:${first.id}`, `user:${second.id}`].sort()
    );
    const secondRows = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.eventType, "user.unknown_origin_detected"),
          eq(auditLog.resource, `user:${second.id}`)
        )
      );
    expect(secondRows).toHaveLength(1);
  });

  it("writes nothing when every account is accounted for", async () => {
    await insertUser({ name: "Setup Admin", role: "admin", createdAt: t(0) });

    expect(await reportUnknownOriginUsers()).toBe(0);
    expect(await detectionRows()).toHaveLength(0);
  });
});
