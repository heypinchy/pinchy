// Real-DB integration test for POST /api/invite/claim.
//
// Pre-#229 this route was tested entirely against vi.mock("@/db") chains;
// passing tests said nothing about whether the actual Drizzle queries, the
// invites/users/userGroups schemas, or Better Auth's signUpEmail integration
// worked end-to-end. This suite exercises all of them against a freshly
// migrated Postgres test database (provisioned by global-setup.ts) and
// truncated between cases (setup.ts).
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
vi.mock("@/lib/invites", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/invites")>();
  return {
    ...actual,
    claimInvite: vi.fn(actual.claimInvite),
  };
});

import { db } from "@/db";
import {
  invites,
  users,
  userGroups,
  groups,
  inviteGroups,
  sessions,
  accounts,
  auditLog,
} from "@/db/schema";
import { createInvite, claimInvite } from "@/lib/invites";
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
    expect(entry.actorId).toBe(targetUser!.id);
    expect(entry.outcome).toBe("success");
    // PII must NOT appear in detail (audit policy).
    const serializedDetail = JSON.stringify(entry.detail ?? {});
    expect(serializedDetail).not.toContain("audit-reset@test.local");
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
