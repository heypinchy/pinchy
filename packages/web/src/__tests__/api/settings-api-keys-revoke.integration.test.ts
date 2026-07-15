// Real-DB integration test for DELETE /api/settings/api-keys/[keyId] — the
// org-wide revoke path (#572 follow-up, Task C).
//
// This suite exists because the route makes a deliberate, security-critical
// bypass: instead of better-auth's own `auth.api.deleteApiKey` (session-scoped
// — it can only revoke the CALLING admin's own keys, no `userId`/org override,
// and Pinchy runs no `organization` plugin), it issues
// `db.delete(apiKeys).where(eq(apiKeys.id, keyId))` directly, so ANY admin can
// revoke ANY key. See the route's docblock for the governance rationale.
//
// A bypass like that carries exactly two ways to be wrong, and this suite
// proves both against a real Postgres, THROUGH THE ACTUAL ROUTE:
//
//   1. The WHERE could be unpinned or pinned to the wrong id — a hand-written
//      `db.delete()` has no type-level guard forcing it to scope to `keyId`.
//      An unpinned delete would wipe every key in the org and still answer
//      200. So: seed TWO keys, revoke ONE, and assert the bystander both
//      SURVIVES and STILL AUTHENTICATES.
//
//   2. The row could vanish while the key keeps authenticating — a "revoke"
//      that is pure security theater. That happens if better-auth serves
//      verifies from a cache rather than the DB. `lib/auth.ts` configures no
//      `secondaryStorage`, and the `apiKey()` plugin gets no `storage`
//      override, so the plugin default (`storage: "database"`) applies and
//      every `verifyApiKey` reads the row live. That is the STATIC argument;
//      the assertion below is the DYNAMIC proof, and it is what would catch a
//      future dependency bump silently switching Pinchy onto a cache.
//
// Both assertions must run against the real route, not an inlined copy of its
// query — a test that re-implements the DELETE it claims to cover proves only
// that Postgres deletes rows.
//
// Provisioned by global-setup.ts (fresh migrated DB) and truncated between
// tests (setup.ts). Only the session and `after()` are faked; the DB, the key
// plugin, and the audit chain all run for real.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

// `after()` needs a real request scope, which route handlers invoked directly
// from a test don't have. Run the callback inline and track the promise so the
// test body can await the audit write before querying for it. Mirrors
// diagnostics-export.integration.test.ts.
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
      try {
        const result = fn();
        if (result instanceof Promise) pendingAfter.push(result.catch(() => {}));
      } catch {
        // Swallowed — matches Next's after() error handling.
      }
    }),
  };
});

// getSession would otherwise require Better Auth cookies on the NextRequest.
// importOriginal keeps `auth` real — this suite needs genuine
// createApiKey/verifyApiKey round-trips.
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/auth")>();
  return { ...actual, getSession: vi.fn() };
});

import { db } from "@/db";
import { apiKeys, auditLog, users } from "@/db/schema";
import { auth, getSession } from "@/lib/auth";
import { DELETE } from "@/app/api/settings/api-keys/[keyId]/route";

/** Seeds an admin and points the mocked `getSession` at them. */
async function seedAdminSession() {
  const result = await auth.api.signUpEmail({
    body: { name: "Revoke Admin", email: "revoke-admin@test.local", password: "apipassword123" },
  });
  const adminId = result.user.id;
  await db.update(users).set({ role: "admin" }).where(eq(users.id, adminId));
  vi.mocked(getSession).mockResolvedValue({
    user: { id: adminId, email: "revoke-admin@test.local", role: "admin" },
  } as unknown as Awaited<ReturnType<typeof getSession>>);
  return adminId;
}

function revokeRequest(keyId: string) {
  return new NextRequest(`http://localhost/api/settings/api-keys/${keyId}`, { method: "DELETE" });
}

function ctx(keyId: string) {
  return { params: Promise.resolve({ keyId }) };
}

async function verifies(key: string): Promise<boolean> {
  const result = await auth.api.verifyApiKey({ body: { key } });
  return result.valid;
}

describe("DELETE /api/settings/api-keys/[keyId] against a real database", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    pendingAfter.length = 0;
  });

  // The revoke test below never awaits its own audit write, so without this
  // the write stays in flight past the test and races the next test's
  // beforeEach truncate. The audit-row test awaits flushAfter() inline because
  // it asserts on the row; this hook covers the ones that don't.
  afterEach(async () => {
    await flushAfter();
  });

  it("revokes ONLY the targeted key: the bystander survives, still authenticates, and the victim is truly dead", async () => {
    const adminId = await seedAdminSession();

    const victim = await auth.api.createApiKey({ body: { name: "victim", userId: adminId } });
    const bystander = await auth.api.createApiKey({ body: { name: "bystander", userId: adminId } });

    // Anchor: both keys genuinely authenticate first. Without this, the
    // valid:false below would prove nothing.
    expect(await verifies(victim.key)).toBe(true);
    expect(await verifies(bystander.key)).toBe(true);

    const response = await DELETE(revokeRequest(victim.id), ctx(victim.id));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ success: true });

    // THE pin (failure mode 1): an unpinned or mis-pinned WHERE would take the
    // bystander with it, and this route would still have answered 200.
    const remaining = await db.select({ id: apiKeys.id }).from(apiKeys);
    expect(remaining.map((r) => r.id)).toEqual([bystander.id]);
    expect(await verifies(bystander.key)).toBe(true);

    // THE revoke (failure mode 2): the same plaintext that verified moments
    // ago must now fail. Still `true` here means a cache kept the key alive
    // and the whole org-wide-bypass design is unsafe.
    const afterRevoke = await auth.api.verifyApiKey({ body: { key: victim.key } });
    expect(afterRevoke.valid).toBe(false);
    expect(afterRevoke.key).toBeNull();
  });

  it("writes a real api_key.deleted audit row naming the admin and the pre-delete key name", async () => {
    const adminId = await seedAdminSession();
    const created = await auth.api.createApiKey({ body: { name: "CI Deploy", userId: adminId } });

    await DELETE(revokeRequest(created.id), ctx(created.id));
    await flushAfter();

    // Through appendAuditLog for real — HMAC chain and all — not a mock
    // assertion. The key's name must survive its own row's deletion.
    const [row] = await db
      .select()
      .from(auditLog)
      .where(eq(auditLog.resource, `api_key:${created.id}`));

    expect(row).toBeDefined();
    expect(row.eventType).toBe("api_key.deleted");
    expect(row.actorType).toBe("user");
    expect(row.outcome).toBe("success");
    expect(row.detail).toEqual({ name: "CI Deploy" });
  });

  it("returns 404 for an unknown key without touching the existing ones", async () => {
    const adminId = await seedAdminSession();
    const survivor = await auth.api.createApiKey({ body: { name: "survivor", userId: adminId } });

    const response = await DELETE(revokeRequest("no-such-key"), ctx("no-such-key"));

    expect(response.status).toBe(404);
    const remaining = await db.select({ id: apiKeys.id }).from(apiKeys);
    expect(remaining.map((r) => r.id)).toEqual([survivor.id]);
  });
});
