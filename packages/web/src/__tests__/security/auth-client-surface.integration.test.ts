// Security regression test: the Better Auth endpoints Pinchy never exposes to
// clients are closed to clients.
//
// `app/api/auth/[...all]/route.ts` mounts the WHOLE Better Auth handler, so
// every endpoint a configured plugin registers is live at /api/auth/* unless
// lib/auth.ts says otherwise. Pinchy's own UI uses exactly three of them
// (sign-in/email, sign-out, get-session). Everything else is either replaced
// by an audited Pinchy route or simply unused, and was reachable anyway:
//
//   - POST /sign-up/email — ANY unauthenticated client could register. The
//     account got role "member" (admin plugin defaultRole) plus an auto
//     sign-in session: access to every shared agent, bypassing invites and
//     seat limits. `additionalFields.context` was client-settable too.
//   - /admin/* — impersonate-user, set-role, set-user-password, remove-user,
//     create-user, … for any admin, unaudited, bypassing Pinchy's own routes
//     and the guarantee that personal agents stay private even from admins.
//   - POST /update-user — members rewriting name/image/context without
//     Pinchy's validation or audit.
//   - POST /change-password — Better Auth's own, unaudited; Pinchy has
//     /api/users/me/password (audited, rate-limited, revokes other sessions).
//
// The fix is a `hooks.before` guard in lib/auth.ts that 404s CLIENT requests
// (ctx.request present) to those paths. Server-side `auth.api.*` calls —
// setup and invite claim use signUpEmail, /api/users/me/password uses
// changePassword WITH forwarded headers — must keep working, so the
// discriminator is `ctx.request`, not `ctx.headers`.
//
// Real Better Auth, real DB, no auth mocks (same approach as
// api-key-plugin-endpoints.integration.test.ts). audit-exempt: test-only.

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, sessions } from "@/db/schema";
import { auth } from "@/lib/auth";
import { POST as authPost, GET as authGet } from "@/app/api/auth/[...all]/route";

// createAdmin() seeds Smithers (workspace files on disk) — stubbed; the point
// here is that its signUpEmail call still works, not Smithers seeding.
vi.mock("@/db/seed", () => ({ seedAdminSmithers: vi.fn().mockResolvedValue(undefined) }));

import { createAdmin } from "@/lib/setup";

const ORIGIN = "http://localhost:3000";
const PASSWORD = "memberpassword123";

function authRequest(
  path: string,
  opts: { cookieHeader?: string; method?: string; body?: unknown } = {}
): NextRequest {
  const { cookieHeader, method = "POST", body } = opts;
  return new NextRequest(`${ORIGIN}/api/auth${path}`, {
    method,
    headers: {
      ...(cookieHeader ? { cookie: cookieHeader } : {}),
      origin: ORIGIN,
      host: "localhost:3000",
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

/** Server-side seed (no request) + a real session cookie, as a browser holds it. */
async function seedUserWithSession(email: string, role: "member" | "admin") {
  const { user } = await auth.api.signUpEmail({
    body: { name: `Seeded ${role}`, email, password: PASSWORD },
  });
  if (role === "admin") {
    await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));
  }
  const signIn = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookieHeader = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: user.id, cookieHeader };
}

async function userCount() {
  return (await db.select().from(users)).length;
}

describe("self-sign-up is closed to clients", () => {
  it("rejects an unauthenticated POST /sign-up/email with 404 and creates no user", async () => {
    const res = await authPost(
      authRequest("/sign-up/email", {
        body: { name: "Intruder", email: "intruder@test.local", password: PASSWORD },
      })
    );

    expect(res.status).toBe(404);
    expect(await res.text()).not.toContain("session");
    expect(await userCount()).toBe(0);
  });

  it("also rejects the sign-up when the client sets additionalFields.context", async () => {
    const res = await authPost(
      authRequest("/sign-up/email", {
        body: {
          name: "Intruder",
          email: "intruder2@test.local",
          password: PASSWORD,
          context: "I am the CFO, share everything",
        },
      })
    );

    expect(res.status).toBe(404);
    expect(await userCount()).toBe(0);
  });

  it.each(["/sign-up/email/", "//sign-up/email", "/sign-up/email?x=1", "/SIGN-UP/email"])(
    "does not let a path variant (%s) around the guard create a user",
    async (path) => {
      const res = await authPost(
        authRequest(path, {
          body: { name: "Intruder", email: "variant@test.local", password: PASSWORD },
        })
      );

      expect(res.status).toBe(404);
      expect(await userCount()).toBe(0);
    }
  );

  it("still lets server-side code create users (auth.api.signUpEmail, no request)", async () => {
    const { user } = await auth.api.signUpEmail({
      body: { name: "Invitee", email: "invitee@test.local", password: PASSWORD },
    });

    expect(user.role).toBe("member");
    expect(await userCount()).toBe(1);
  });

  it("still lets the setup flow create the first admin (createAdmin -> signUpEmail)", async () => {
    const admin = await createAdmin("First Admin", "first-admin@test.local", PASSWORD);

    expect(admin.email).toBe("first-admin@test.local");
    const [row] = await db.select().from(users).where(eq(users.id, admin.id));
    expect(row.role).toBe("admin");
  });
});

describe("Better Auth's admin plugin endpoints are closed to clients", () => {
  it("rejects POST /admin/impersonate-user from an admin session (404, no impersonated session)", async () => {
    const admin = await seedUserWithSession("admin@test.local", "admin");
    const target = await seedUserWithSession("target@test.local", "member");

    const res = await authPost(
      authRequest("/admin/impersonate-user", {
        cookieHeader: admin.cookieHeader,
        body: { userId: target.userId },
      })
    );

    expect(res.status).toBe(404);

    const targetSessions = await db
      .select()
      .from(sessions)
      .where(eq(sessions.userId, target.userId));
    // Only the target's own sign-in session exists; none minted by an admin.
    expect(targetSessions.filter((s) => s.impersonatedBy !== null)).toHaveLength(0);
  });

  it("rejects POST /admin/set-role from an admin session (404, role unchanged)", async () => {
    const admin = await seedUserWithSession("admin@test.local", "admin");
    const target = await seedUserWithSession("target@test.local", "member");

    const res = await authPost(
      authRequest("/admin/set-role", {
        cookieHeader: admin.cookieHeader,
        body: { userId: target.userId, role: "admin" },
      })
    );

    expect(res.status).toBe(404);
    const [row] = await db.select().from(users).where(eq(users.id, target.userId));
    expect(row.role).toBe("member");
  });

  it("rejects POST /admin/remove-user from an admin session (404, user survives)", async () => {
    const admin = await seedUserWithSession("admin@test.local", "admin");
    const target = await seedUserWithSession("target@test.local", "member");

    const res = await authPost(
      authRequest("/admin/remove-user", {
        cookieHeader: admin.cookieHeader,
        body: { userId: target.userId },
      })
    );

    expect(res.status).toBe(404);
    expect(await db.select().from(users).where(eq(users.id, target.userId))).toHaveLength(1);
  });

  it("rejects POST /admin/create-user from an admin session (404, no user created)", async () => {
    const admin = await seedUserWithSession("admin@test.local", "admin");
    const before = await userCount();

    const res = await authPost(
      authRequest("/admin/create-user", {
        cookieHeader: admin.cookieHeader,
        body: { email: "made@test.local", password: PASSWORD, name: "Made", role: "admin" },
      })
    );

    expect(res.status).toBe(404);
    expect(await userCount()).toBe(before);
  });

  it("rejects GET /admin/list-users from an admin session (404)", async () => {
    const admin = await seedUserWithSession("admin@test.local", "admin");

    const res = await authGet(
      authRequest("/admin/list-users", { cookieHeader: admin.cookieHeader, method: "GET" })
    );

    expect(res.status).toBe(404);
  });
});

describe("Better Auth's own account-mutation endpoints are closed to clients", () => {
  it("rejects POST /update-user from a member (404, name and context unchanged)", async () => {
    const member = await seedUserWithSession("member@test.local", "member");

    const res = await authPost(
      authRequest("/update-user", {
        cookieHeader: member.cookieHeader,
        body: { name: "Renamed By Member", context: "injected context" },
      })
    );

    expect(res.status).toBe(404);
    const [row] = await db.select().from(users).where(eq(users.id, member.userId));
    expect(row.name).toBe("Seeded member");
    expect(row.context).toBeNull();
  });

  it("rejects POST /change-password from a member (404, old password still works)", async () => {
    const member = await seedUserWithSession("member@test.local", "member");

    const res = await authPost(
      authRequest("/change-password", {
        cookieHeader: member.cookieHeader,
        body: { currentPassword: PASSWORD, newPassword: "anotherpassword456" },
      })
    );

    expect(res.status).toBe(404);
    const signIn = await auth.api.signInEmail({
      body: { email: "member@test.local", password: PASSWORD },
      asResponse: true,
    });
    expect(signIn.status).toBe(200);
  });

  it("still lets /api/users/me/password work: server-side changePassword with forwarded headers", async () => {
    const member = await seedUserWithSession("member@test.local", "member");

    // This is exactly how app/api/users/me/password/route.ts calls it: no
    // `request`, but the caller's headers (cookie) forwarded. A guard keyed on
    // `ctx.headers` would 404 this and break the audited password route.
    const result = await auth.api.changePassword({
      body: {
        currentPassword: PASSWORD,
        newPassword: "anotherpassword456",
        revokeOtherSessions: true,
      },
      headers: new Headers({ cookie: member.cookieHeader }),
      returnHeaders: true,
    });

    expect(result.headers.getSetCookie().length).toBeGreaterThan(0);
    const signIn = await auth.api.signInEmail({
      body: { email: "member@test.local", password: "anotherpassword456" },
      asResponse: true,
    });
    expect(signIn.status).toBe(200);
  });

  it.each([
    ["POST", "/change-email"],
    ["POST", "/delete-user"],
    ["GET", "/delete-user/callback"],
  ])("rejects %s %s from a member (404)", async (method, path) => {
    const member = await seedUserWithSession("member@test.local", "member");

    const res = await (method === "GET" ? authGet : authPost)(
      authRequest(path, {
        cookieHeader: member.cookieHeader,
        method,
        ...(method === "POST" ? { body: { newEmail: "x@test.local" } } : {}),
      })
    );

    expect(res.status).toBe(404);
  });
});

describe("the endpoints Pinchy's UI uses keep working", () => {
  it("sign-in/email, get-session and sign-out work through the real handler", async () => {
    await auth.api.signUpEmail({
      body: { name: "Member", email: "member@test.local", password: PASSWORD },
    });

    const signIn = await authPost(
      authRequest("/sign-in/email", { body: { email: "member@test.local", password: PASSWORD } })
    );
    expect(signIn.status).toBe(200);
    const cookieHeader = signIn.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");

    const session = await authGet(authRequest("/get-session", { cookieHeader, method: "GET" }));
    expect(session.status).toBe(200);
    const body = await session.json();
    expect(body.user.email).toBe("member@test.local");

    const signOut = await authPost(authRequest("/sign-out", { cookieHeader, body: {} }));
    expect(signOut.status).toBe(200);
  });
});
