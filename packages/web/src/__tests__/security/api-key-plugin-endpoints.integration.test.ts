// Security regression test for #572 whole-branch review finding C1
// (CRITICAL): registering `apiKey()` in lib/auth.ts mounts FIVE ungoverned
// HTTP endpoints — `/api-key/create|update|delete|get|list`. Because
// `app/api/auth/[...all]/route.ts` mounts the WHOLE auth handler, these are
// live at `/api/auth/api-key/*` for ANY authenticated session — not just
// admins, and not through Pinchy's own audited `withAdmin` route at
// `/api/settings/api-keys`.
//
// Those five are exactly the plugin's path-carrying endpoints. It declares
// two others via `createAuthEndpoint.serverOnly` — `verifyApiKey` and
// `deleteAllExpiredApiKeys` — and NEITHER carries a path, so neither is
// reachable over HTTP at all; they exist only as `auth.api.*` calls. (There
// is no `/api-key/verify` route to speak of, despite the name.) All five
// blocked below, one test each: an untested endpoint here is an open door.
//
// This is the mirror of session-routes-reject-api-key.integration.test.ts —
// same real-auth, real-DB, no-mocks approach. That file asks "can a key open
// a session route?"; this one asks "what HTTP surface did the plugin add?"
//
// D1 (enableSessionForAPIKeys: false) is NOT what's under test here — the
// point is that a `pinchy_` key can be MINTED at all by a non-admin, with no
// audit row (`auditAfterHook` only handles /sign-in/email + /sign-out).
//
// Containment (verified below, not just asserted): permissions is a
// server-only field on create/update. A client (cookie-carrying) request
// can't set it, so a self-minted key always gets `permissions: null` →
// `extractScopes` → `[]` → withApiKey's `required.every(...)` check fails on
// any required scope → every /api/v1 call 403s. That containment is real,
// but it doesn't excuse the missing admin gate + missing audit trail, and it
// falsifies the docs claim that "every key lifecycle event is written to the
// audit trail."
//
// Fix: a `hooks.before` middleware in lib/auth.ts blocks any CLIENT request
// (ctx.request || ctx.headers present — the same discriminator the plugin
// itself uses for its server-only property checks) to `/api-key/*` with a
// 404, while leaving Pinchy's own server-side `auth.api.createApiKey({body})`
// call (no headers/request) untouched.
//
// Provisioned by global-setup.ts (fresh migrated DB), truncated between
// tests (setup.ts). audit-exempt: test-only.

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { apiKeys } from "@/db/schema";
import { auth } from "@/lib/auth";
import { POST as authPost, GET as authGet } from "@/app/api/auth/[...all]/route";

const ORIGIN = "http://localhost:3000";

/**
 * Signs up a plain member (admin plugin's `defaultRole: "member"` applies —
 * no promotion, unlike the D1 test's seedAdminWithKey) and signs them in,
 * returning a `Cookie` header string built from the real Set-Cookie values
 * Better Auth issues. This is exactly what a browser would send on the next
 * request — no mocking of session resolution anywhere in this file.
 */
async function seedMemberSessionCookie() {
  const { user } = await auth.api.signUpEmail({
    body: { name: "Plain Member", email: "member@test.local", password: "memberpassword123" },
  });
  expect(user.role).toBe("member");

  const signIn = await auth.api.signInEmail({
    body: { email: "member@test.local", password: "memberpassword123" },
    asResponse: true,
  });
  const cookieHeader = signIn.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  return { userId: user.id, cookieHeader };
}

/**
 * Builds a same-origin, cookie-carrying Request against the auth handler's
 * mounted `/api-key/*` sub-path — exactly as a malicious (or merely curious)
 * signed-in member would construct it. Origin/Host are required: Better
 * Auth's CSRF origin-check middleware enforces a trusted Origin on any
 * cookie-carrying, non-GET request (see better-auth's
 * api/middlewares/origin-check.mjs `validateOrigin`), and lib/auth.ts's
 * `trustedOrigins` derives its allow-list from the request's own Host header
 * when no domain is locked (test env) — so Origin/Host must agree.
 */
function apiKeyRequest(
  path: string,
  opts: { cookieHeader: string; method?: string; body?: unknown }
): NextRequest {
  const { cookieHeader, method = "POST", body } = opts;
  return new NextRequest(`${ORIGIN}/api/auth${path}`, {
    method,
    headers: {
      cookie: cookieHeader,
      origin: ORIGIN,
      host: "localhost:3000",
      "content-type": "application/json",
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

describe("C1: the api-key plugin's HTTP endpoints are governed (#572 review)", () => {
  it("blocks a non-admin member from minting a key via POST /api-key/create (404, no row created)", async () => {
    const { userId, cookieHeader } = await seedMemberSessionCookie();

    const res = await authPost(
      apiKeyRequest("/api-key/create", { cookieHeader, body: { name: "member-minted-key" } })
    );

    expect(res.status).toBe(404);

    const rows = await db.select().from(apiKeys).where(eq(apiKeys.referenceId, userId));
    expect(rows).toHaveLength(0);
  });

  it("blocks a non-admin member from listing keys via GET /api-key/list (404)", async () => {
    const { cookieHeader } = await seedMemberSessionCookie();

    const res = await authGet(apiKeyRequest("/api-key/list", { cookieHeader, method: "GET" }));

    expect(res.status).toBe(404);
  });

  it("blocks a non-admin member from deleting a key via POST /api-key/delete (404, key survives)", async () => {
    const { userId, cookieHeader } = await seedMemberSessionCookie();

    // Seed a real key the member owns, the same way Pinchy's own admin route
    // does server-side (no headers) — this isolates the assertion to the
    // DELETE endpoint's governance, not key creation.
    const created = await auth.api.createApiKey({
      body: { name: "pre-existing-key", userId },
    });

    const res = await authPost(
      apiKeyRequest("/api-key/delete", { cookieHeader, body: { keyId: created.id } })
    );

    expect(res.status).toBe(404);

    const rows = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(rows).toHaveLength(1);
  });

  it("blocks a non-admin member from reading a key via GET /api-key/get (404)", async () => {
    const { userId, cookieHeader } = await seedMemberSessionCookie();
    const created = await auth.api.createApiKey({ body: { name: "pre-existing-key", userId } });

    const res = await authGet(
      apiKeyRequest(`/api-key/get?id=${created.id}`, { cookieHeader, method: "GET" })
    );

    expect(res.status).toBe(404);
    // Belt-and-suspenders on the 404: a body that somehow carried the row
    // would leak `start`/`prefix`/metadata past Pinchy's masking whitelist.
    expect(await res.text()).not.toContain("pre-existing-key");
  });

  it("blocks a non-admin member from mutating a key via POST /api-key/update (404, key unchanged)", async () => {
    const { userId, cookieHeader } = await seedMemberSessionCookie();
    const created = await auth.api.createApiKey({
      body: { name: "pre-existing-key", userId, enabled: true },
    });

    const res = await authPost(
      apiKeyRequest("/api-key/update", {
        cookieHeader,
        body: { keyId: created.id, name: "renamed-by-member", enabled: false },
      })
    );

    expect(res.status).toBe(404);

    // The row is untouched. Renaming matters more than it looks: the name is
    // what the settings list and every audit `detail` snapshot show, so a
    // member who could rewrite it could disguise which key did what.
    const [row] = await db.select().from(apiKeys).where(eq(apiKeys.id, created.id));
    expect(row.name).toBe("pre-existing-key");
    expect(row.enabled).toBe(true);
  });
});
