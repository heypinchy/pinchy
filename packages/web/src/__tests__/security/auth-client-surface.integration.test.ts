// Security regression test: Better Auth answers HTTP clients on exactly three
// endpoints, and nothing else.
//
// `app/api/auth/[...all]/route.ts` mounts the WHOLE Better Auth handler, so
// every endpoint a configured plugin registers is live at /api/auth/* unless
// lib/auth.ts says otherwise. Pinchy's own UI uses exactly three of them
// (sign-in/email, sign-out, get-session). Everything else is either replaced
// by an audited Pinchy route or simply unused, and was reachable anyway:
//
//   - POST /sign-up/email — ANY unauthenticated client could register. The
//     account got role "member" (admin plugin defaultRole) plus an auto
//     sign-in session, bypassing invites and seat limits.
//     `additionalFields.context` was client-settable too.
//   - /admin/* — impersonate-user, set-role, set-user-password, remove-user,
//     create-user, … for any admin, unaudited, bypassing Pinchy's own routes
//     and the guarantee that personal agents stay private even from admins.
//   - POST /update-user — members rewriting name/image/context without
//     Pinchy's validation or audit.
//   - POST /change-password — Better Auth's own, unaudited; Pinchy has
//     /api/users/me/password (audited, rate-limited, revokes other sessions).
//   - POST /verify-password — answers "is this the password?" for the
//     session's own user, outside the sign-in rate limit: a password oracle
//     for anyone holding a stolen session.
//
// The first fix was a blocklist, and it missed /verify-password — which is
// the argument against blocklists. The guard in lib/auth.ts is now an
// ALLOWLIST (`CLIENT_REACHABLE_AUTH_PATHS`): a CLIENT request (ctx.request
// present) to any other endpoint gets a bodyless 404. The drift guard at the
// bottom enumerates every endpoint `auth.api` declares, so an endpoint a
// Better Auth bump adds is covered by construction.
//
// Server-side `auth.api.*` calls — setup and invite claim use signUpEmail,
// /api/users/me/password uses changePassword WITH forwarded headers — must
// keep working, so the discriminator is `ctx.request`, not `ctx.headers`.
//
// How a test tells the GUARD's 404 apart from every other 404 (the review of
// the blocklist found two tests that passed without the guard): Better Auth's
// router answers an unknown route with a bodyless 404, and a disabled
// endpoint (deleteUser) throws a bodyless 404 of its own. A status/body check
// cannot separate them. So `sendAsClient` spies on `hooks.before`, and
// `expectRefusedByGuard` requires that the router matched the endpoint, that
// the guard itself returned the 404, and that the client received it.
//
// Real Better Auth, real DB, no auth mocks (same approach as
// api-key-plugin-endpoints.integration.test.ts). audit-exempt: test-only.

import { describe, it, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users, sessions } from "@/db/schema";
import { auth, CLIENT_REACHABLE_AUTH_PATHS } from "@/lib/auth";
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

type ClientResult = { res: Response; dispatchedPaths: string[]; guardRefusals: number };

/** Did a `hooks.before` invocation itself answer with a 404 Response? */
function isGuardRefusal(hookReturn: unknown): boolean {
  // createAuthMiddleware returns `{ headers, response }` (dispatch asks for
  // returnHeaders); `response` is whatever the hook returned.
  if (typeof hookReturn !== "object" || hookReturn === null || !("response" in hookReturn)) {
    return false;
  }
  const { response } = hookReturn;
  return response instanceof Response && response.status === 404;
}

/**
 * Sends `req` through `handler` like a browser would, recording which declared
 * endpoint paths Better Auth dispatched it to (= ran `hooks.before` for), and
 * how many of those hook runs themselves returned the refusal. An empty
 * `dispatchedPaths` means the router never matched a route — its own 404,
 * which says nothing about the guard.
 */
async function sendAsClient(
  handler: (req: NextRequest) => Promise<Response>,
  req: NextRequest
): Promise<ClientResult> {
  const hooks = auth.options.hooks;
  if (!hooks?.before) throw new Error("lib/auth.ts registers no hooks.before guard");
  const spy = vi.spyOn(hooks, "before");
  try {
    const res = await handler(req);
    // `path` is set by Better Auth's dispatch (the endpoint's declared path)
    // but not part of the middleware input type.
    const dispatchedPaths = spy.mock.calls.map(([ctx]) => ("path" in ctx ? String(ctx.path) : ""));
    const guardRefusals = spy.mock.settledResults.filter(
      (r) => r.type === "fulfilled" && isGuardRefusal(r.value)
    ).length;
    return { res, dispatchedPaths, guardRefusals };
  } finally {
    spy.mockRestore();
  }
}

/**
 * The guard's refusal, and only the guard's. The wire alone cannot prove it:
 * Better Auth's router answers an unknown route with a bodyless 404, and a
 * disabled endpoint can too — deleteUser throws `APIError.fromStatus
 * ("NOT_FOUND")`, which serializes to an empty body. So this requires that
 * the router matched `declaredPath`, that the guard ITSELF returned the 404
 * (before the endpoint could run), and that the client got that bodyless 404.
 */
async function expectRefusedByGuard(
  { res, dispatchedPaths, guardRefusals }: ClientResult,
  declaredPath: string
) {
  expect(dispatchedPaths).toEqual([declaredPath]);
  expect(guardRefusals).toBe(1);
  expect(res.status).toBe(404);
  expect(await res.text()).toBe("");
}

describe("self-sign-up is closed to clients", () => {
  it("rejects an unauthenticated POST /sign-up/email with 404 and creates no user", async () => {
    const result = await sendAsClient(
      authPost,
      authRequest("/sign-up/email", {
        body: { name: "Intruder", email: "intruder@test.local", password: PASSWORD },
      })
    );

    await expectRefusedByGuard(result, "/sign-up/email");
    expect(await userCount()).toBe(0);
  });

  it("also rejects the sign-up when the client sets additionalFields.context", async () => {
    const result = await sendAsClient(
      authPost,
      authRequest("/sign-up/email", {
        body: {
          name: "Intruder",
          email: "intruder2@test.local",
          password: PASSWORD,
          context: "I am the CFO, share everything",
        },
      })
    );

    await expectRefusedByGuard(result, "/sign-up/email");
    expect(await userCount()).toBe(0);
  });

  // Of these four, only `?x=1` reaches the guard. The other three are refused
  // by Better Auth's ROUTER before any endpoint is dispatched: a trailing slash
  // is a 404 (skipTrailingSlashes is off), so is any `//`, and route matching
  // is case-sensitive. They stay as regression cover — a router change that
  // starts matching them must still not create a user — but they prove
  // nothing about the guard; the test after this one does.
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

  it("checks the endpoint's declared path, not the URL: a query-string variant reaches the guard and is refused", async () => {
    const result = await sendAsClient(
      authPost,
      authRequest("/sign-up/email?callbackURL=/&x=1", {
        body: { name: "Intruder", email: "variant@test.local", password: PASSWORD },
      })
    );

    await expectRefusedByGuard(result, "/sign-up/email");
    expect(await userCount()).toBe(0);
  });

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

    const result = await sendAsClient(
      authPost,
      authRequest("/admin/impersonate-user", {
        cookieHeader: admin.cookieHeader,
        body: { userId: target.userId },
      })
    );

    await expectRefusedByGuard(result, "/admin/impersonate-user");

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

    const result = await sendAsClient(
      authPost,
      authRequest("/admin/set-role", {
        cookieHeader: admin.cookieHeader,
        body: { userId: target.userId, role: "admin" },
      })
    );

    await expectRefusedByGuard(result, "/admin/set-role");
    const [row] = await db.select().from(users).where(eq(users.id, target.userId));
    expect(row.role).toBe("member");
  });

  it("rejects POST /admin/remove-user from an admin session (404, user survives)", async () => {
    const admin = await seedUserWithSession("admin@test.local", "admin");
    const target = await seedUserWithSession("target@test.local", "member");

    const result = await sendAsClient(
      authPost,
      authRequest("/admin/remove-user", {
        cookieHeader: admin.cookieHeader,
        body: { userId: target.userId },
      })
    );

    await expectRefusedByGuard(result, "/admin/remove-user");
    expect(await db.select().from(users).where(eq(users.id, target.userId))).toHaveLength(1);
  });

  it("rejects POST /admin/create-user from an admin session (404, no user created)", async () => {
    const admin = await seedUserWithSession("admin@test.local", "admin");
    const before = await userCount();

    const result = await sendAsClient(
      authPost,
      authRequest("/admin/create-user", {
        cookieHeader: admin.cookieHeader,
        body: { email: "made@test.local", password: PASSWORD, name: "Made", role: "admin" },
      })
    );

    await expectRefusedByGuard(result, "/admin/create-user");
    expect(await userCount()).toBe(before);
  });

  it("rejects GET /admin/list-users from an admin session (404)", async () => {
    const admin = await seedUserWithSession("admin@test.local", "admin");

    const result = await sendAsClient(
      authGet,
      authRequest("/admin/list-users", { cookieHeader: admin.cookieHeader, method: "GET" })
    );

    await expectRefusedByGuard(result, "/admin/list-users");
  });
});

describe("Better Auth's own account-mutation endpoints are closed to clients", () => {
  it("rejects POST /update-user from a member (404, name and context unchanged)", async () => {
    const member = await seedUserWithSession("member@test.local", "member");

    const result = await sendAsClient(
      authPost,
      authRequest("/update-user", {
        cookieHeader: member.cookieHeader,
        body: { name: "Renamed By Member", context: "injected context" },
      })
    );

    await expectRefusedByGuard(result, "/update-user");
    const [row] = await db.select().from(users).where(eq(users.id, member.userId));
    expect(row.name).toBe("Seeded member");
    expect(row.context).toBeNull();
  });

  it("rejects POST /change-password from a member (404, old password still works)", async () => {
    const member = await seedUserWithSession("member@test.local", "member");

    const result = await sendAsClient(
      authPost,
      authRequest("/change-password", {
        cookieHeader: member.cookieHeader,
        body: { currentPassword: PASSWORD, newPassword: "anotherpassword456" },
      })
    );

    await expectRefusedByGuard(result, "/change-password");
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

  // /delete-user is the case that used to pass without the guard: deleteUser
  // is disabled in our config and answers a bodyless 404 of its own. Only the
  // hook-return check in `expectRefusedByGuard` tells that apart.
  it.each([
    ["POST", "/change-email", "/change-email", { newEmail: "x@test.local" }],
    ["POST", "/delete-user", "/delete-user", { password: PASSWORD }],
    ["GET", "/delete-user/callback?token=x", "/delete-user/callback", undefined],
  ])(
    "rejects %s %s from a member (guard's 404, user unchanged)",
    async (method, url, path, body) => {
      const member = await seedUserWithSession("member@test.local", "member");

      const result = await sendAsClient(
        method === "GET" ? authGet : authPost,
        authRequest(url, { cookieHeader: member.cookieHeader, method, body })
      );

      await expectRefusedByGuard(result, path);
      const [row] = await db.select().from(users).where(eq(users.id, member.userId));
      expect(row.email).toBe("member@test.local");
    }
  );

  it("rejects POST /verify-password from a member: a stolen session is no password oracle", async () => {
    // Missed by the first (blocklist) version of this fix. With a session
    // cookie it answers {status:true|false} for any guess, and the sign-in
    // rate limit does not cover it.
    const member = await seedUserWithSession("member@test.local", "member");

    const result = await sendAsClient(
      authPost,
      authRequest("/verify-password", {
        cookieHeader: member.cookieHeader,
        body: { password: PASSWORD },
      })
    );

    await expectRefusedByGuard(result, "/verify-password");
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

// ── Drift guard ────────────────────────────────────────────────────────────
//
// Enumerates every endpoint Better Auth itself declares (`auth.api`, the same
// map its router is built from) instead of a hand-kept list — a hand-kept
// list is exactly what missed /verify-password. A Better Auth bump that adds
// an endpoint lands here as a new case, refused by construction.

type DeclaredEndpoint = {
  path?: string;
  options?: { method?: string | string[]; metadata?: object };
};

function isServerOnly(endpoint: DeclaredEndpoint): boolean {
  const metadata = endpoint.options?.metadata;
  return metadata !== undefined && "SERVER_ONLY" in metadata && metadata.SERVER_ONLY === true;
}

const declaredEndpoints: { name: string; path: string; method: string }[] = Object.entries(
  auth.api
).flatMap(([name, fn]) => {
  const endpoint: DeclaredEndpoint = fn;
  // Same filter better-call's router applies: no path, or SERVER_ONLY, means
  // no route — those exist only as `auth.api.*` calls.
  if (!endpoint.path || isServerOnly(endpoint)) return [];
  const methods = [endpoint.options?.method ?? "GET"].flat();
  return methods.map((method) => ({ name, path: endpoint.path as string, method }));
});

const closedEndpoints = declaredEndpoints.filter((e) => !CLIENT_REACHABLE_AUTH_PATHS.has(e.path));

describe("drift guard: every Better Auth endpoint outside the allowlist is closed to clients", () => {
  it("the allowlist is exactly the three endpoints Pinchy's UI calls", () => {
    // Widening this is a security decision: it needs this line changed, and a
    // reason in lib/auth.ts next to the entry.
    expect([...CLIENT_REACHABLE_AUTH_PATHS].sort()).toEqual([
      "/get-session",
      "/sign-in/email",
      "/sign-out",
    ]);
  });

  it("every allowlisted path is a real HTTP endpoint (no stale entries)", () => {
    const routed = new Set(declaredEndpoints.map((e) => e.path));
    for (const path of CLIENT_REACHABLE_AUTH_PATHS) expect(routed).toContain(path);
  });

  it("found a real endpoint corpus to check (a broken enumeration must not pass in silence)", () => {
    expect(closedEndpoints.length).toBeGreaterThan(40);
    // Spot-check the enumeration reaches the plugins and the finding that
    // started the allowlist.
    const paths = closedEndpoints.map((e) => e.path);
    expect(paths).toEqual(
      expect.arrayContaining(["/verify-password", "/admin/impersonate-user", "/api-key/create"])
    );
  });

  it.each(closedEndpoints)(
    "refuses a client $method $path ($name), even from an admin session",
    async ({ path, method }) => {
      const admin = await seedUserWithSession("admin@test.local", "admin");

      // `auth.handler` is what the mounted route delegates to; calling it
      // directly also covers a method the Next route does not export today.
      const result = await sendAsClient(
        (req) => auth.handler(req),
        authRequest(path.replace(/:[^/]+/g, "x"), {
          cookieHeader: admin.cookieHeader,
          method,
          body: method === "GET" ? undefined : {},
        })
      );

      await expectRefusedByGuard(result, path);
    }
  );
});
