import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * DELETE /api/settings/api-keys/[keyId] — revoke an Agent Provisioning API
 * key, org-wide (#572 follow-up).
 *
 * Same org-wide rationale as the GET rewrite in settings-api-keys.test.ts:
 * better-auth's `deleteApiKey` is session-scoped (it can only revoke the
 * CALLING admin's own keys — no `userId`/org override, and Pinchy runs no
 * `organization` plugin), which would leave orphaned keys un-revocable once
 * their issuing admin leaves. So this route bypasses `auth.api.deleteApiKey`
 * and deletes directly from `schema.apiKeys` via Drizzle — any admin can
 * revoke any key.
 *
 * CRITICAL governance point (design D2), same as the sibling POST/GET route:
 * this is a session-authenticated admin action, so the audit actor is the
 * ADMIN (`actorType: "user"`, `actorId: session.user.id`) — never
 * `"api_key"`.
 *
 * SCOPE — read this before adding a security assertion here. `db` is mocked,
 * so this suite can only prove the route's plumbing: auth, 404 handling, and
 * the audit actor/detail shape. It CANNOT prove either half of the bypass's
 * safety, and must not be read as doing so:
 *   - that the delete is pinned to `keyId` (a mocked `.where()` swallows any
 *     predicate — asserting it was *called* says nothing about what it was
 *     called WITH; a WHERE wiping every enabled key passes right through);
 *   - that a deleted row actually stops authenticating.
 * Both are proven against a real Postgres, through the real route, in
 * settings-api-keys-revoke.integration.test.ts. That suite is the safety
 * guarantee behind bypassing better-auth's own delete endpoint — this one is
 * not.
 */

const { mockGetSession, mockDbDelete } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockDbDelete: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  auth: {
    api: {
      getSession: mockGetSession,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/db", () => ({
  db: {
    delete: mockDbDelete,
  },
}));

import { DELETE } from "@/app/api/settings/api-keys/[keyId]/route";
import { appendAuditLog } from "@/lib/audit";
import { apiKeys } from "@/db/schema";

// ── Helpers ─────────────────────────────────────────────────────────────

function adminSession() {
  return { user: { id: "admin-1", email: "admin@test.com", role: "admin" } };
}

function memberSession() {
  return { user: { id: "member-1", email: "member@test.com", role: "member" } };
}

function deleteRequest(): NextRequest {
  return new NextRequest("http://localhost/api/settings/api-keys/key-1", {
    method: "DELETE",
  });
}

function ctx(keyId = "key-1") {
  return { params: Promise.resolve({ keyId }) };
}

/**
 * Sets up `db.delete(apiKeys).where(...).returning(...)`.
 *
 * `row` is what the DELETE actually removed — `null` means it matched nothing.
 * The route derives BOTH its 404 and its audit name from this one result,
 * which is the point: a separate existence check would let two concurrent
 * revokes each believe they were the one that deleted the key.
 */
function mockDeleteChain(row: { name: string | null } | null) {
  // `null`, not `undefined`, for "matched nothing" — a default parameter would
  // swallow an explicit `undefined` and hand back the row instead, quietly
  // turning every 404 test into a 200 test.
  const returning = vi.fn().mockResolvedValue(row ? [row] : []);
  const where = vi.fn().mockReturnValue({ returning });
  mockDbDelete.mockReturnValue({ where });
  return { where, returning };
}

describe("DELETE /api/settings/api-keys/[keyId]", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession());
  });

  it("returns 200 with { success: true } and deletes the key from the apikey table", async () => {
    const { where: deleteWhere } = mockDeleteChain({ name: "CI Deploy" });

    const response = await DELETE(deleteRequest(), ctx("key-1"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ success: true });
    expect(mockDbDelete).toHaveBeenCalledWith(apiKeys);
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  // ── Headline assertion: the audit surface Pinchy sells ──────────────────

  it("audits api_key.deleted with actorType 'user' (the admin), resource api_key:<id>, and DeleteDetail{name} captured pre-delete", async () => {
    mockDeleteChain({ name: "CI Deploy" });

    const response = await DELETE(deleteRequest(), ctx("key-77"));
    expect(response.status).toBe(200);

    // Exact-match: proves the detail carries ONLY {name} — no other field
    // (e.g. a stray `key`/`permissions`) could sneak in unnoticed.
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "api_key.deleted",
      resource: "api_key:key-77",
      detail: { name: "CI Deploy" },
      outcome: "success",
    });
  });

  it("coalesces a null name to an empty string in the audit detail (name can be null in the DB)", async () => {
    mockDeleteChain({ name: null });

    await DELETE(deleteRequest(), ctx("key-1"));

    expect(appendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ detail: { name: "" } }));
  });

  it("404s on an unknown key, deciding from what the DELETE removed", async () => {
    // The route used to SELECT, decide, then DELETE. Two admins revoking the
    // same key would both find it, both answer 200, and both write an
    // `api_key.deleted` row — two revocations recorded for one revoke, in the
    // table that exists to be evidence. Now the DELETE runs unconditionally
    // and `returning` decides: exactly one caller gets the row, the loser gets
    // nothing and 404s truthfully. So "no delete was attempted" is deliberately
    // NOT asserted here — attempting it is the fix.
    const { returning } = mockDeleteChain(null);

    const response = await DELETE(deleteRequest(), ctx("nonexistent"));

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "API key not found" });
    expect(mockDbDelete).toHaveBeenCalledWith(apiKeys);
    expect(returning).toHaveBeenCalled();
    // Nothing was removed, so nothing is recorded as removed.
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden for a non-admin session and never touches the table", async () => {
    mockGetSession.mockResolvedValue(memberSession());

    const response = await DELETE(deleteRequest(), ctx("key-1"));

    expect(response.status).toBe(403);
    expect(mockDbDelete).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});
