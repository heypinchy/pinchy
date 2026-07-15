import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * POST + GET /api/settings/api-keys — admin key-management surface (#572,
 * Tasks 5.1 + 5.2).
 *
 * CRITICAL governance point (design D2), distinct from the key-authenticated
 * /api/v1/agents routes: here a human ADMIN manages keys through the
 * session-authenticated UI, so the audit actor is `actorType: "user"` /
 * `actorId: session.user.id` — never `"api_key"`. The event's *resource* is
 * an api_key (`api_key.created`, `resource: "api_key:<id>"`), but the actor
 * performing the action is the admin.
 *
 * `auth.api.createApiKey` is mocked for POST. GET is org-wide (#572
 * follow-up): better-auth's `listApiKeys` has no server-side `userId`/org
 * override and Pinchy runs no `organization` plugin, so it can only ever
 * return the CALLING admin's own keys — a governance hole (an admin who
 * leaves orphans keys no other admin can see or revoke). GET therefore reads
 * `schema.apiKeys` directly via Drizzle, bypassing that session-scoped
 * endpoint entirely, so this suite mocks `@/db` instead of
 * `auth.api.listApiKeys` (mirrors the `mockDbSelect` pattern used by
 * agents-audit.test.ts / v1/agents-delete.test.ts). Either way, this suite
 * exercises the ROUTE's job (auth, validation, one-time plaintext handling,
 * audit actor/detail shape, and the response masking whitelist), not
 * better-auth's own plugin logic (already covered by
 * auth-apikey.integration.test.ts).
 */

const { mockGetSession, mockCreateApiKey, mockDbSelect } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockCreateApiKey: vi.fn(),
  mockDbSelect: vi.fn(),
}));

// `api-auth.ts`'s withAdmin/withAuth call the plain `getSession` export;
// some other routes/tests also reach `auth.api.getSession` — both point at
// the same mock so either call style resolves the same session (mirrors
// agents-create.test.ts).
vi.mock("@/lib/auth", () => ({
  getSession: mockGetSession,
  auth: {
    api: {
      getSession: mockGetSession,
      createApiKey: mockCreateApiKey,
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
  db: { select: mockDbSelect },
}));

import { POST, GET } from "@/app/api/settings/api-keys/route";
import { appendAuditLog } from "@/lib/audit";
import { apiKeys } from "@/db/schema";

// ── Helpers ─────────────────────────────────────────────────────────────

function adminSession() {
  return { user: { id: "admin-1", email: "admin@test.com", role: "admin" } };
}

function memberSession() {
  return { user: { id: "member-1", email: "member@test.com", role: "member" } };
}

function postRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/settings/api-keys", {
    method: "POST",
    body: JSON.stringify(body),
  });
}

function getRequest(): NextRequest {
  return new NextRequest("http://localhost/api/settings/api-keys");
}

describe("POST /api/settings/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession());
  });

  it("returns 201 with { id, key, name, scopes } including the one-time plaintext key", async () => {
    mockCreateApiKey.mockResolvedValue({
      id: "key-1",
      key: "pinchy_abc123",
      name: "CI Deploy",
      expiresAt: null,
    });

    const response = await POST(postRequest({ name: "CI Deploy", scopes: ["agents:read"] }));
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "key-1",
      key: "pinchy_abc123",
      name: "CI Deploy",
      scopes: ["agents:read"],
    });
  });

  it("calls auth.api.createApiKey with mapped permissions and the admin session as owner, no headers", async () => {
    mockCreateApiKey.mockResolvedValue({
      id: "key-1",
      key: "pinchy_abc",
      name: "CI",
      expiresAt: null,
    });

    await POST(postRequest({ name: "CI", scopes: ["agents:read", "agents:write"] }));

    // No `headers`/`request` field: permissions/userId are server-only
    // fields on this endpoint — passing headers would make better-auth treat
    // this as a client request and throw SERVER_ONLY_PROPERTY.
    expect(mockCreateApiKey).toHaveBeenCalledWith({
      body: {
        name: "CI",
        permissions: { agents: ["read", "write"] },
        expiresIn: undefined,
        userId: "admin-1",
      },
    });
  });

  it("converts expiresInDays to seconds for the plugin's expiresIn field", async () => {
    mockCreateApiKey.mockResolvedValue({
      id: "key-1",
      key: "pinchy_abc",
      name: "CI",
      expiresAt: new Date("2026-08-14T00:00:00.000Z"),
    });

    await POST(postRequest({ name: "CI", scopes: ["agents:read"], expiresInDays: 30 }));

    expect(mockCreateApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ expiresIn: 30 * 86400 }) })
    );
  });

  it("audits api_key.created with actorType 'user' (the admin) and never includes the plaintext key", async () => {
    mockCreateApiKey.mockResolvedValue({
      id: "key-1",
      key: "pinchy_super_secret_value",
      name: "CI Deploy",
      expiresAt: null,
    });

    const response = await POST(postRequest({ name: "CI Deploy", scopes: ["agents:read"] }));
    expect(response.status).toBe(201);

    // Exact-match: proves the detail carries ONLY {id, name, scopes,
    // expiresAt} — no `key` field could sneak in unnoticed.
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "user",
      actorId: "admin-1",
      eventType: "api_key.created",
      resource: "api_key:key-1",
      detail: { id: "key-1", name: "CI Deploy", scopes: ["agents:read"], expiresAt: null },
      outcome: "success",
    });

    // Defense in depth beyond the exact-match above: the plaintext secret
    // must not appear ANYWHERE in any appendAuditLog call, ever.
    for (const call of vi.mocked(appendAuditLog).mock.calls) {
      expect(JSON.stringify(call)).not.toContain("pinchy_super_secret_value");
    }
  });

  it("returns 400 for an empty name and never creates a key or audits", async () => {
    const response = await POST(postRequest({ name: "", scopes: ["agents:read"] }));

    expect(response.status).toBe(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 for empty scopes (default-deny: at least one scope required)", async () => {
    const response = await POST(postRequest({ name: "CI", scopes: [] }));

    expect(response.status).toBe(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown/invalid scope", async () => {
    const response = await POST(postRequest({ name: "CI", scopes: ["agents:admin"] }));

    expect(response.status).toBe(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden for a non-admin session and never creates a key", async () => {
    mockGetSession.mockResolvedValue(memberSession());

    const response = await POST(postRequest({ name: "CI", scopes: ["agents:read"] }));

    expect(response.status).toBe(403);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });
});

describe("GET /api/settings/api-keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetSession.mockResolvedValue(adminSession());
  });

  /**
   * Sets up `db.select().from(apiKeys).orderBy(...)` to resolve to `rows`.
   * Mirrors the route's actual chain — `.from()` returns an object whose
   * ONLY chained method is `.orderBy()` (no `.where()`), so a route that
   * regressed to filtering by the caller's own `referenceId` (i.e. went back
   * to being per-admin, not org-wide) would call a `.where()` that doesn't
   * exist on this mock and fail loudly rather than silently narrowing.
   */
  function mockKeyRows(rows: unknown[]) {
    const orderBy = vi.fn().mockResolvedValue(rows);
    const from = vi.fn().mockReturnValue({ orderBy });
    mockDbSelect.mockReturnValue({ from });
    return { from, orderBy };
  }

  // A full apiKey row shape (matches every column in db/schema.ts's
  // `apiKeys` table) so the whitelist tests below prove real leaks, not
  // leaks of fields a hand-trimmed fixture never had in the first place.
  function fullKeyRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "key-1",
      name: "CI Deploy",
      start: "pinchy_abc",
      prefix: "pinchy_",
      key: "should-never-appear-in-response",
      referenceId: "admin-1",
      configId: "default",
      refillInterval: null,
      refillAmount: null,
      lastRefillAt: null,
      enabled: true,
      rateLimitEnabled: true,
      rateLimitTimeWindow: null,
      rateLimitMax: null,
      requestCount: 0,
      remaining: null,
      lastRequest: null,
      expiresAt: null,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-01T00:00:00.000Z"),
      permissions: JSON.stringify({ agents: ["read", "write"] }),
      metadata: null,
      ...overrides,
    };
  }

  it("returns 200 with a masked key list containing only the safe whitelisted fields", async () => {
    mockKeyRows([fullKeyRow()]);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      keys: [
        {
          id: "key-1",
          name: "CI Deploy",
          start: "pinchy_abc",
          scopes: ["agents:read", "agents:write"],
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          lastRequest: null,
          enabled: true,
        },
      ],
    });
  });

  it("queries the apikey table directly, org-wide — no per-admin filter", async () => {
    const { from } = mockKeyRows([]);

    await GET(getRequest());

    expect(mockDbSelect).toHaveBeenCalled();
    expect(from).toHaveBeenCalledWith(apiKeys);
  });

  it("returns keys from multiple different admins in one call (the org-wide guarantee)", async () => {
    mockKeyRows([
      fullKeyRow({ id: "key-1", name: "Admin One's key", referenceId: "admin-1" }),
      fullKeyRow({ id: "key-2", name: "Admin Two's key", referenceId: "admin-2" }),
    ]);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(body.keys.map((k: { id: string }) => k.id)).toEqual(["key-1", "key-2"]);
  });

  it("never leaks a hashed key, raw permissions, or metadata field", async () => {
    mockKeyRows([
      fullKeyRow({
        // Defensive: even if a future refactor widened the select, the
        // route's whitelist must drop these regardless.
        key: "should-never-appear-in-response",
        metadata: JSON.stringify({ secret: "nope" }),
      }),
    ]);

    const response = await GET(getRequest());
    const body = await response.json();
    const bodyText = JSON.stringify(body);

    expect(bodyText).not.toContain("should-never-appear-in-response");
    expect(body.keys[0]).not.toHaveProperty("key");
    expect(body.keys[0]).not.toHaveProperty("permissions");
    expect(body.keys[0]).not.toHaveProperty("metadata");
    expect(body.keys[0]).not.toHaveProperty("prefix");
    expect(body.keys[0]).not.toHaveProperty("referenceId");
    // Whitelist is exhaustive: no field beyond the 8 documented safe ones.
    expect(Object.keys(body.keys[0]).sort()).toEqual(
      ["createdAt", "enabled", "expiresAt", "id", "lastRequest", "name", "scopes", "start"].sort()
    );
  });

  it("maps the raw JSON permissions string to scopes via parsePermissions/extractScopes, dropping unknown grants", async () => {
    mockKeyRows([
      fullKeyRow({
        id: "key-1",
        name: "K1",
        start: null,
        permissions: JSON.stringify({ agents: ["read", "admin"], billing: ["read"] }),
      }),
    ]);

    const response = await GET(getRequest());
    const body = await response.json();

    // "agents:admin" and "billing:read" are not valid API_KEY_SCOPES — must
    // be dropped, not passed through as if they were granted capabilities.
    expect(body.keys[0].scopes).toEqual(["agents:read"]);
  });

  it("maps a null permissions column to an empty scopes array", async () => {
    mockKeyRows([fullKeyRow({ permissions: null })]);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(body.keys[0].scopes).toEqual([]);
  });

  it("degrades to an empty scopes array (not a crash/500) when the permissions column is invalid JSON", async () => {
    mockKeyRows([fullKeyRow({ permissions: "{not-valid-json" })]);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.keys[0].scopes).toEqual([]);
  });

  it("returns an empty keys array when there are no keys", async () => {
    mockKeyRows([]);

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ keys: [] });
  });

  it("does not write an audit entry (read-only, audit-exempt)", async () => {
    mockKeyRows([]);

    await GET(getRequest());

    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden for a non-admin session and never queries keys", async () => {
    mockGetSession.mockResolvedValue(memberSession());

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
