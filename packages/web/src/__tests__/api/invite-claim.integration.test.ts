// Real-DB integration test for POST /api/invite/claim.
//
// Pre-#229 this route was tested entirely against vi.mock("@/db") chains;
// passing tests said nothing about whether the actual Drizzle queries, the
// invites/users/userGroups schemas, or Better Auth's signUpEmail integration
// worked end-to-end. This suite exercises all of them against a freshly
// migrated Postgres test database (provisioned by global-setup.ts) and
// emptied between cases by the integration reset.
//
// What stays mocked, and why:
//   - @/lib/personal-agent.seedPersonalAgent — touches the real filesystem
//     (workspace dirs, SOUL.md). Has its own coverage; not in scope here.
//   - @/lib/openclaw-config.regenerateOpenClawConfig — writes openclaw.json.
//     Same reasoning.
//
// Everything else (Better Auth signup + setUserPassword, invite token
// validation, claim transaction, group assignment) runs for real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

// The account-creation audit row is written through deferAuditLog (next's
// after()), which throws outside a request scope. Run the callback inline
// and collect its promise so a test can await the write before reading the
// audit table.
const pendingAfter: Promise<unknown>[] = [];
async function flushAfter(): Promise<void> {
  while (pendingAfter.length > 0) {
    await Promise.allSettled(pendingAfter.splice(0));
  }
}
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return {
    ...actual,
    after: vi.fn((fn: () => void | Promise<void>) => {
      const result = fn();
      if (result instanceof Promise) pendingAfter.push(result);
    }),
  };
});

vi.mock("@/lib/personal-agent", () => ({
  seedPersonalAgent: vi.fn().mockResolvedValue({ id: "fake-agent-id" }),
}));

vi.mock("@/lib/openclaw-config", () => ({
  regenerateOpenClawConfig: vi.fn().mockResolvedValue(undefined),
}));

// Partial-mock invites so individual tests can force `claimInvite` to
// throw mid-flow — that's the only way to exercise the reset-path
// transaction rollback without faking out the DB layer itself. Default
// behavior delegates to the real implementation; tests use
// `vi.mocked(claimInvite).mockImplementationOnce(...)` to override.
//
// Side effect: `vi.fn(actual.claimInvite)` wraps the real function with a
// spy, so every test in this suite — not just the rollback one — gets
// call-tracking on `claimInvite` for free (call counts, args, etc.).
// No assertion currently relies on those counts, but if you add such an
// assertion later, remember it's the spy you're asserting against, not
// the real `lib/invites` export. `vi.clearAllMocks()` in `beforeEach`
// keeps the counts isolated per test.
vi.mock("@/lib/invites", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invites")>();
  return {
    ...actual,
    claimInvite: vi.fn(actual.claimInvite),
  };
});

import { db } from "@/db";
import { invites, users, userGroups, groups, inviteGroups, sessions, auditLog } from "@/db/schema";
import { createInvite, claimInvite, INVITE_WITHOUT_EMAIL_ERROR } from "@/lib/invites";
import { seedPersonalAgent } from "@/lib/personal-agent";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { auth } from "@/lib/auth";
import { POST } from "@/app/api/invite/claim/route";

function makeRequest(body: Record<string, unknown>) {
  return new NextRequest("http://localhost:7777/api/invite/claim", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

async function seedAdmin() {
  // createInvite requires a referenced createdBy user (FK on invites.created_by).
  // signUpEmail wires through Better Auth so the resulting row matches what a
  // real admin would look like.
  const result = await auth.api.signUpEmail({
    body: { name: "Admin", email: "admin@test.local", password: "adminpassword123" },
  });
  return result.user.id;
}

describe("POST /api/invite/claim (integration)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Validation ──────────────────────────────────────────────────────

  it("returns 400 when token is missing", async () => {
    const response = await POST(makeRequest({ name: "Test User", password: "Br1ghtNova!2" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.token).toBeDefined();
  });

  it("returns 400 when password is missing", async () => {
    const response = await POST(makeRequest({ token: "valid-token", name: "Test User" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    // password is now schema-required (parseRequestBody catches the missing
    // field before validatePassword() runs).
    expect(body.error).toBe("Validation failed");
    expect(body.details.fieldErrors.password).toBeDefined();
  });

  it("returns 400 when password is too short", async () => {
    const response = await POST(
      makeRequest({ token: "valid-token", name: "Test User", password: "short" })
    );
    expect(response.status).toBe(400);
    // Length is enforced post-parse by validatePassword(), so the freeform
    // error string is preserved here (12-char policy from #234).
    expect(await response.json()).toEqual({ error: "Password must be at least 12 characters" });
  });

  it("returns 410 when token is invalid", async () => {
    const response = await POST(
      makeRequest({ token: "bad-token", name: "Test User", password: "Br1ghtNova!2" })
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: "Invalid or expired invite link" });
  });

  it("returns 410 when token is already claimed", async () => {
    const adminId = await seedAdmin();
    const { token } = await createInvite({
      email: "claimed@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });

    // First claim succeeds
    const first = await POST(makeRequest({ token, name: "First User", password: "Br1ghtNova!2" }));
    expect(first.status).toBe(201);

    // Second claim with same token fails
    const second = await POST(
      makeRequest({ token, name: "Second User", password: "Br1ghtNova!2" })
    );
    expect(second.status).toBe(410);
  });

  it("returns 410 when token is expired", async () => {
    const adminId = await seedAdmin();
    const { token, tokenHash } = await createInvite({
      email: "expired@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });
    // Backdate expiry directly — createInvite always sets +7 days.
    await db
      .update(invites)
      .set({ expiresAt: new Date(Date.now() - 60_000) })
      .where(eq(invites.tokenHash, tokenHash));

    const response = await POST(
      makeRequest({ token, name: "Late User", password: "Br1ghtNova!2" })
    );
    expect(response.status).toBe(410);
  });

  it("returns 400 when name is missing for new user invite", async () => {
    const adminId = await seedAdmin();
    const { token } = await createInvite({
      email: "noname@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });

    const response = await POST(makeRequest({ token, password: "Br1ghtNova!2" }));
    expect(response.status).toBe(400);
    // Name-required is enforced post-parse only when the invite type is
    // "invite" (resets don't require it), so the legacy freeform error
    // string is preserved here.
    expect(await response.json()).toEqual({ error: "Name is required" });
  });

  // ── Successful new user invite ──────────────────────────────────────

  it("creates the user and marks the invite claimed on success", async () => {
    const adminId = await seedAdmin();
    const { token, tokenHash } = await createInvite({
      email: "invited@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });

    const response = await POST(makeRequest({ token, name: "New User", password: "Br1ghtNova!2" }));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ success: true });

    const user = await db.query.users.findFirst({
      where: eq(users.email, "invited@test.local"),
    });
    expect(user).toMatchObject({
      email: "invited@test.local",
      name: "New User",
      role: "member",
    });

    const invite = await db.query.invites.findFirst({ where: eq(invites.tokenHash, tokenHash) });
    expect(invite?.claimedAt).toBeInstanceOf(Date);
    expect(invite?.claimedByUserId).toBe(user!.id);
  });

  it("seeds a personal agent and regenerates OpenClaw config for new users", async () => {
    const adminId = await seedAdmin();
    const { token } = await createInvite({
      email: "agent-user@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });

    await POST(makeRequest({ token, name: "Agent User", password: "Br1ghtNova!2" }));

    const user = await db.query.users.findFirst({
      where: eq(users.email, "agent-user@test.local"),
    });
    expect(seedPersonalAgent).toHaveBeenCalledWith(user!.id, false);
    expect(regenerateOpenClawConfig).toHaveBeenCalled();
  });

  it("promotes invite role=admin to a real admin row", async () => {
    const adminId = await seedAdmin();
    const { token } = await createInvite({
      email: "newadmin@test.local",
      role: "admin",
      type: "invite",
      createdBy: adminId,
    });

    const response = await POST(
      makeRequest({ token, name: "New Admin", password: "Br1ghtNova!2" })
    );
    expect(response.status).toBe(201);

    const newAdmin = await db.query.users.findFirst({
      where: eq(users.email, "newadmin@test.local"),
    });
    expect(newAdmin?.role).toBe("admin");
    // seedPersonalAgent receives isAdmin=true so Smithers gets the org-context tool.
    expect(seedPersonalAgent).toHaveBeenCalledWith(newAdmin!.id, true);
  });

  // ── Audit: account creation ─────────────────────────────────────────

  it("writes a user.created audit row for the account a claimed invite creates", async () => {
    // Before this row existed, an account's only trace in the audit trail was
    // the inviter's `user.invited` — nothing recorded that the invite became
    // an account, or which one. Actor is the new user (pseudonymized on the
    // actorId column); their raw id and email stay out of `detail`.
    const adminId = await seedAdmin();
    const invite = await createInvite({
      email: "audited@test.local",
      role: "admin",
      type: "invite",
      createdBy: adminId,
    });

    const response = await POST(
      makeRequest({ token: invite.token, name: "Audited User", password: "Br1ghtNova!2" })
    );
    expect(response.status).toBe(201);
    await flushAfter();

    const user = await db.query.users.findFirst({ where: eq(users.email, "audited@test.local") });
    const rows = await db.select().from(auditLog).where(eq(auditLog.eventType, "user.created"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "user",
      actorId: user!.auditPseudonym,
      outcome: "success",
    });
    expect(rows[0].detail).toEqual({
      name: "Audited User",
      role: "admin",
      via: "invite",
      invite: { id: invite.id },
    });
    const serialized = JSON.stringify(rows[0]);
    expect(serialized).not.toContain("audited@test.local");
    expect(serialized).not.toContain(user!.id);
  });

  it("refuses an invite without an email and records the failed claim (#1263)", async () => {
    // Invites created before the email became required have none. Better
    // Auth cannot create an account without one, so the claim used to fail
    // with a bare 500 and leave no trace in the audit trail.
    const adminId = await seedAdmin();
    const invite = await createInvite({ role: "member", type: "invite", createdBy: adminId });

    const response = await POST(
      makeRequest({ token: invite.token, name: "No Mail", password: "Br1ghtNova!2" })
    );
    expect(response.status).toBe(410);
    expect(await response.json()).toEqual({ error: INVITE_WITHOUT_EMAIL_ERROR });
    await flushAfter();

    const created = await db.query.users.findFirst({ where: eq(users.name, "No Mail") });
    expect(created).toBeUndefined();
    const row = await db.query.invites.findFirst({ where: eq(invites.id, invite.id) });
    expect(row?.claimedAt).toBeNull();

    const rows = await db.select().from(auditLog).where(eq(auditLog.eventType, "user.created"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "system",
      actorId: "invite-claim",
      outcome: "failure",
    });
    expect(rows[0].detail).toEqual({
      name: "No Mail",
      role: "member",
      via: "invite",
      invite: { id: invite.id },
      reason: "invite_has_no_email",
    });
  });

  it("keeps the failure row whole when the claim carries a very long name (#1263)", async () => {
    // The name comes from whoever holds the link. Uncapped, it can push the
    // detail past the audit size limit, which replaces the whole detail with
    // a summary and drops the invite id and the reason.
    const adminId = await seedAdmin();
    const invite = await createInvite({ role: "member", type: "invite", createdBy: adminId });

    const response = await POST(
      makeRequest({ token: invite.token, name: "x".repeat(5000), password: "Br1ghtNova!2" })
    );
    expect(response.status).toBe(410);
    await flushAfter();

    const rows = await db.select().from(auditLog).where(eq(auditLog.eventType, "user.created"));
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({
      invite: { id: invite.id },
      reason: "invite_has_no_email",
    });
  });

  it.each([
    ["an emoji split by the length cap", "x".repeat(199) + "\u{1F600}"],
    ["a lone surrogate in the body", "Broken \uD83D name"],
    ["a NUL character", "Nul\u0000name"],
  ])("still writes the failure row for a name with %s (#1263)", async (_label, name) => {
    // Postgres jsonb refuses a lone UTF-16 surrogate and NUL. A name carrying
    // either would make the audit write throw, and the failed claim would
    // again leave no trace.
    const adminId = await seedAdmin();
    const invite = await createInvite({ role: "member", type: "invite", createdBy: adminId });

    const response = await POST(
      makeRequest({ token: invite.token, name, password: "Br1ghtNova!2" })
    );
    expect(response.status).toBe(410);
    await flushAfter();

    const rows = await db.select().from(auditLog).where(eq(auditLog.eventType, "user.created"));
    expect(rows).toHaveLength(1);
    expect(rows[0].detail).toMatchObject({ reason: "invite_has_no_email" });
  });

  it("records a failure row when Better Auth refuses the sign-up (#1263)", async () => {
    // An account already holds the invite's email, so signUpEmail rejects.
    // The invite must stay usable and the attempt must be on the record.
    const adminId = await seedAdmin();
    await auth.api.signUpEmail({
      body: { name: "Taken", email: "taken@test.local", password: "originalpassword1" },
    });
    const invite = await createInvite({
      email: "taken@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });

    const response = await POST(
      makeRequest({ token: invite.token, name: "Second Taker", password: "Br1ghtNova!2" })
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Failed to create account" });
    await flushAfter();

    const row = await db.query.invites.findFirst({ where: eq(invites.id, invite.id) });
    expect(row?.claimedAt).toBeNull();

    const rows = await db.select().from(auditLog).where(eq(auditLog.eventType, "user.created"));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "system",
      actorId: "invite-claim",
      outcome: "failure",
    });
    expect(rows[0].detail).toEqual({
      name: "Second Taker",
      role: "member",
      via: "invite",
      invite: { id: invite.id },
      reason: "sign_up_failed",
    });
    expect(JSON.stringify(rows[0])).not.toContain("taken@test.local");
  });

  it("writes no user.created row for a password-reset claim", async () => {
    const adminId = await seedAdmin();
    await auth.api.signUpEmail({
      body: { name: "Resetter", email: "resetter@test.local", password: "originalpassword1" },
    });
    const { token } = await createInvite({
      email: "resetter@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });

    const response = await POST(makeRequest({ token, password: "newpassword456" }));
    expect(response.status).toBe(200);
    await flushAfter();

    const rows = await db.select().from(auditLog).where(eq(auditLog.eventType, "user.created"));
    expect(rows).toHaveLength(0);
  });

  // ── Group assignment on claim ───────────────────────────────────────

  it("assigns invite groups to the new user after claiming", async () => {
    const adminId = await seedAdmin();
    const [groupA] = await db.insert(groups).values({ name: "Engineering" }).returning();
    const [groupB] = await db.insert(groups).values({ name: "Design" }).returning();

    const { token } = await createInvite({
      email: "grouped@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
      groupIds: [groupA.id, groupB.id],
    });

    const response = await POST(
      makeRequest({ token, name: "Grouped User", password: "Br1ghtNova!2" })
    );
    expect(response.status).toBe(201);

    const newUser = await db.query.users.findFirst({
      where: eq(users.email, "grouped@test.local"),
    });
    const memberships = await db
      .select({ groupId: userGroups.groupId })
      .from(userGroups)
      .where(eq(userGroups.userId, newUser!.id));
    expect(memberships.map((m) => m.groupId).sort()).toEqual([groupA.id, groupB.id].sort());
  });

  it("does not assign any groups when the invite has none", async () => {
    const adminId = await seedAdmin();
    const { token } = await createInvite({
      email: "groupless@test.local",
      role: "member",
      type: "invite",
      createdBy: adminId,
    });

    await POST(makeRequest({ token, name: "Groupless User", password: "Br1ghtNova!2" }));

    const newUser = await db.query.users.findFirst({
      where: eq(users.email, "groupless@test.local"),
    });
    const memberships = await db
      .select()
      .from(userGroups)
      .where(eq(userGroups.userId, newUser!.id));
    expect(memberships).toHaveLength(0);
  });

  // ── Password reset (type "reset") ──────────────────────────────────

  it("resets the password of an existing user and claims the invite", async () => {
    const adminId = await seedAdmin();

    // Create the user being reset.
    const targetSignup = await auth.api.signUpEmail({
      body: { name: "Existing User", email: "existing@test.local", password: "originalpassword1" },
    });
    const targetId = targetSignup.user.id;

    const { token, tokenHash } = await createInvite({
      email: "existing@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });

    // Reset to a new password.
    const response = await POST(makeRequest({ token, password: "newpassword123" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    // Sign in with the new password should work.
    const signIn = await auth.api.signInEmail({
      body: { email: "existing@test.local", password: "newpassword123" },
      asResponse: true,
    });
    expect(signIn.status).toBe(200);

    // Sign in with the OLD password should fail.
    await expect(
      auth.api.signInEmail({
        body: { email: "existing@test.local", password: "originalpassword1" },
        asResponse: true,
      })
    ).resolves.toMatchObject({ status: 401 });

    // Invite is marked claimed by the existing user.
    const invite = await db.query.invites.findFirst({ where: eq(invites.tokenHash, tokenHash) });
    expect(invite?.claimedByUserId).toBe(targetId);
  });

  it("never overwrites the existing display name on reset, even if a name is sent", async () => {
    // Guardrail for #436: the reset flow must never touch users.name. The UI
    // hides the name field, but a crafted POST that still carries `name` must
    // not silently overwrite the user's display name (data loss on a
    // security-sensitive flow).
    const adminId = await seedAdmin();
    await auth.api.signUpEmail({
      body: { name: "Original Name", email: "keepname@test.local", password: "originalpassword1" },
    });
    const { token } = await createInvite({
      email: "keepname@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });

    const response = await POST(
      makeRequest({ token, name: "Hijacked Name", password: "newpassword123" })
    );
    expect(response.status).toBe(200);

    const user = await db.query.users.findFirst({
      where: eq(users.email, "keepname@test.local"),
    });
    expect(user?.name).toBe("Original Name");
  });

  it("does NOT seed a personal agent or regenerate config on reset", async () => {
    const adminId = await seedAdmin();
    await auth.api.signUpEmail({
      body: { name: "Reset User", email: "reset@test.local", password: "originalpassword1" },
    });
    const { token } = await createInvite({
      email: "reset@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });

    await POST(makeRequest({ token, password: "newpassword123" }));

    expect(seedPersonalAgent).not.toHaveBeenCalled();
    expect(regenerateOpenClawConfig).not.toHaveBeenCalled();
  });

  it("returns 404 when the reset target user no longer exists", async () => {
    const adminId = await seedAdmin();
    // Create invite for an email that has no corresponding user row.
    const { token } = await createInvite({
      email: "nonexistent@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });

    const response = await POST(makeRequest({ token, password: "newpassword123" }));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "User not found" });
  });

  // ── Session revocation, atomicity, and audit on reset ─────────────

  it("revokes all existing sessions for the user when password is reset", async () => {
    // Reset must invalidate any active sessions on the account being
    // recovered — otherwise a stale/leaked session token survives the reset
    // and the reset's recovery semantics are broken.
    const adminId = await seedAdmin();
    await auth.api.signUpEmail({
      body: { name: "Stale Sessions", email: "stale@test.local", password: "originalpassword1" },
    });

    // Sign the user in twice so we have multiple session rows to revoke.
    await auth.api.signInEmail({
      body: { email: "stale@test.local", password: "originalpassword1" },
      asResponse: true,
    });
    await auth.api.signInEmail({
      body: { email: "stale@test.local", password: "originalpassword1" },
      asResponse: true,
    });

    const targetUser = await db.query.users.findFirst({
      where: eq(users.email, "stale@test.local"),
    });
    const sessionsBefore = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, targetUser!.id));
    expect(sessionsBefore.length).toBeGreaterThanOrEqual(2);

    const { token } = await createInvite({
      email: "stale@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });
    const response = await POST(makeRequest({ token, password: "newpassword456" }));
    expect(response.status).toBe(200);

    const sessionsAfter = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, targetUser!.id));
    expect(sessionsAfter).toHaveLength(0);
  });

  it("rolls back password and session writes if claimInvite fails mid-flow", async () => {
    // Atomicity guard: if claimInvite throws after the password has been
    // updated, the whole reset must roll back. Otherwise a partial
    // failure leaves the user with a new password AND the invite token
    // still claimable, which lets the reset link be replayed.
    const adminId = await seedAdmin();
    await auth.api.signUpEmail({
      body: { name: "Atomic", email: "atomic@test.local", password: "originalpassword1" },
    });

    const { token, tokenHash } = await createInvite({
      email: "atomic@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });

    // Force the route's claimInvite call to throw — every prior write
    // (password hash, session deletion) must roll back.
    const claimInviteMock = vi.mocked(claimInvite);
    claimInviteMock.mockImplementationOnce(async () => {
      throw new Error("simulated DB failure");
    });

    const response = await POST(makeRequest({ token, password: "newpassword456" }));
    expect(response.status).toBe(500);

    // Original password still works → password update was rolled back.
    const signIn = await auth.api.signInEmail({
      body: { email: "atomic@test.local", password: "originalpassword1" },
      asResponse: true,
    });
    expect(signIn.status).toBe(200);

    // New password does NOT work.
    const signInNew = await auth.api.signInEmail({
      body: { email: "atomic@test.local", password: "newpassword456" },
      asResponse: true,
    });
    expect(signInNew.status).toBe(401);

    // Invite is still claimable.
    const inviteRow = await db.query.invites.findFirst({
      where: eq(invites.tokenHash, tokenHash),
    });
    expect(inviteRow?.claimedAt).toBeNull();
  });

  it("writes an auth.password_reset_completed audit entry on successful reset", async () => {
    const adminId = await seedAdmin();
    await auth.api.signUpEmail({
      body: { name: "Audit Me", email: "audit-reset@test.local", password: "originalpassword1" },
    });
    const targetUser = await db.query.users.findFirst({
      where: eq(users.email, "audit-reset@test.local"),
    });

    const { token } = await createInvite({
      email: "audit-reset@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });
    const response = await POST(makeRequest({ token, password: "newpassword456" }));
    expect(response.status).toBe(200);

    const entries = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.eventType, "auth.password_reset_completed"));
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    expect(entry.actorType).toBe("user");
    // appendAuditLog substitutes the user's auditPseudonym for actorId (GDPR
    // crypto-erasure) — assert against that, not the raw targetUser.id.
    expect(entry.actorId).toBe(targetUser!.auditPseudonym);
    expect(entry.outcome).toBe("success");
    // PII must NOT appear in detail (audit policy).
    const serializedDetail = JSON.stringify(entry.detail ?? {});
    expect(serializedDetail).not.toContain("audit-reset@test.local");
    // The actor IS the target here, so its raw users.id stays out of detail
    // (#824): the row snapshots the name and carries the id in `resource`.
    expect(serializedDetail).not.toContain(targetUser!.id);
    expect(entry.detail).toMatchObject({ target: { name: "Audit Me" } });
    expect(entry.resource).toBe(`user:${targetUser!.id}`);
  });

  it("does not assign groups for password reset invites", async () => {
    const adminId = await seedAdmin();
    await auth.api.signUpEmail({
      body: { name: "ResetGroups", email: "resetgroups@test.local", password: "originalpassword1" },
    });
    const [g] = await db.insert(groups).values({ name: "Some Group" }).returning();

    // Manually craft a reset invite linked to a group (createInvite doesn't
    // enforce that reset invites have no groups; the route is what must skip
    // group assignment, which is what we're verifying here).
    const { token, tokenHash } = await createInvite({
      email: "resetgroups@test.local",
      role: "member",
      type: "reset",
      createdBy: adminId,
    });
    const inviteRow = await db.query.invites.findFirst({
      where: eq(invites.tokenHash, tokenHash),
    });
    await db.insert(inviteGroups).values({ inviteId: inviteRow!.id, groupId: g.id });

    await POST(makeRequest({ token, password: "newpassword123" }));

    const targetUser = await db.query.users.findFirst({
      where: eq(users.email, "resetgroups@test.local"),
    });
    const memberships = await db
      .select()
      .from(userGroups)
      .where(eq(userGroups.userId, targetUser!.id));
    expect(memberships).toHaveLength(0);
  });
});
