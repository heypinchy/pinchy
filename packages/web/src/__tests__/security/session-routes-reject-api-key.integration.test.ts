// Security regression test locking in design decision D1 (#572, Task 2.2):
//
//     A valid Pinchy API key MUST NOT resolve to a user session.
//
// API keys are scoped machine credentials for the Agent Provisioning API — not
// login tokens. If a key ever minted a session it would sail straight through
// every session-protected, admin-only route (e.g. GET /api/users) with the full
// authority of the key's owner. Task 1.1 pinned this by registering the
// @better-auth/api-key plugin with `enableSessionForAPIKeys: false`; this test
// proves that guarantee holds against the REAL Better Auth instance and a REAL
// Postgres — deliberately NO auth mocks.
//
// Why this is an INTEGRATION test (real DB), not a unit test: D1 is a claim
// about Better Auth's *runtime* session-resolution, which only exists against a
// live auth instance + DB. A `vi.mock("@/lib/auth")` unit test would prove
// nothing here — it would assert its own stub returned null, never touching the
// behavior under test. So we mint a genuine, valid key through Better Auth and
// present it exactly as a client would.
//
// Teeth (verified during development, then reverted — never committed): flipping
// `enableSessionForAPIKeys` to `true` in src/lib/auth.ts makes this file FAIL —
// the x-api-key key resolves to a session and GET /api/users stops returning
// 401. That the test can fail is what makes its green state meaningful.
//
// Provisioned by global-setup.ts (fresh migrated DB), truncated between tests
// (setup.ts). audit-exempt: test-only.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { users } from "@/db/schema";
import { auth, getSession } from "@/lib/auth";

// GET /api/users derives its caller from `next/headers` — requireAdmin() calls
// getSession({ headers: await headers() }) — not from a request argument. A node
// vitest run has no Next.js request scope, so we substitute that request-scoped
// header store with a real Headers object. This mocks ONLY Next's plumbing:
// getSession, requireAdmin, and Better Auth's key/session resolution all still
// run for real, which is the whole point of the Layer 2 assertion below.
const { mockHeaders } = vi.hoisted(() => ({
  mockHeaders: vi.fn(async () => new Headers()),
}));
vi.mock("next/headers", () => ({ headers: mockHeaders }));

import { GET as getUsers } from "@/app/api/users/route";

/**
 * Seed a real admin user through Better Auth (so the row matches production)
 * and mint a genuine, valid API key for them — the same server-side call the
 * provisioning API uses. `permissions` is a server-only field, so the call
 * carries no headers/request. The one-time plaintext key comes back on create.
 *
 * The user is an admin on purpose: GET /api/users is admin-only, so a leaked
 * session here would be maximally damaging (a bare key returning 200 on an
 * admin route). That is the sharpest possible statement of what D1 forbids.
 */
async function seedAdminWithKey() {
  const { user } = await auth.api.signUpEmail({
    body: {
      name: "Provisioning Admin",
      email: "d1-admin@test.local",
      password: "apipassword123",
    },
  });
  await db.update(users).set({ role: "admin" }).where(eq(users.id, user.id));

  const created = await auth.api.createApiKey({
    body: {
      name: "d1-provisioning-token",
      userId: user.id,
      permissions: { agents: ["read"] },
    },
  });
  return { userId: user.id, key: created.key };
}

describe("D1: API keys do not open session-protected routes (integration)", () => {
  beforeEach(() => {
    // Reset the injected header store to empty between tests so a key set for
    // the Layer 2 route call can never leak into another test.
    mockHeaders.mockResolvedValue(new Headers());
  });

  // ── Layer 1: getSession itself refuses to derive a session from a key ─────

  it("getSession returns null for a valid key presented in the x-api-key header", async () => {
    const { key } = await seedAdminWithKey();

    // Anchor: the key is genuinely valid AS A KEY. This is what makes the
    // null-session result below meaningful — a real, working credential that is
    // categorically NOT a session credential. (verifyApiKey is a distinct route
    // from session resolution; it stays valid regardless of the D1 flag.)
    const verified = await auth.api.verifyApiKey({ body: { key } });
    expect(verified.valid).toBe(true);

    const session = await getSession({ headers: new Headers({ "x-api-key": key }) });
    expect(session).toBeNull();
  });

  it("getSession returns null for a valid key presented as Authorization: Bearer", async () => {
    const { key } = await seedAdminWithKey();

    const session = await getSession({
      headers: new Headers({ authorization: `Bearer ${key}` }),
    });
    expect(session).toBeNull();
  });

  // ── Layer 2: the full route → requireAdmin → getSession chain denies ──────

  it("GET /api/users returns 401 for a valid key with no session cookie", async () => {
    const { key } = await seedAdminWithKey();
    // Present the key the way a programmatic client would — as the sole
    // credential on the request, no session cookie.
    mockHeaders.mockResolvedValue(new Headers({ "x-api-key": key }));

    const res = await getUsers();

    // 401 (not 200, not 403): with D1 intact there is NO session at all, so the
    // route denies at the *authentication* gate. If the key ever minted a
    // session, this admin-owned key would sail through to 200 and this
    // assertion would fail — exactly the regression D1 forbids.
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });
});
