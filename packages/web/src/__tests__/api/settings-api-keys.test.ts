import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { routeContext } from "@/test-helpers/route";

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
import { apiKeys, users } from "@/db/schema";
import { PINCHY_SERVICE_ACCOUNT_ID } from "@/lib/api-key-identity";

// ── Helpers ─────────────────────────────────────────────────────────────

function adminSession() {
  return { user: { id: "admin-1", name: "Ada Admin", email: "admin@test.com", role: "admin" } };
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

    const response = await POST(
      postRequest({ name: "CI Deploy", scopes: ["agents:read"] }),
      routeContext()
    );
    const body = await response.json();

    expect(response.status).toBe(201);
    expect(body).toEqual({
      id: "key-1",
      key: "pinchy_abc123",
      name: "CI Deploy",
      scopes: ["agents:read"],
    });
  });

  it("issues the key against the org service account, with the admin only as createdBy provenance", async () => {
    mockCreateApiKey.mockResolvedValue({
      id: "key-1",
      key: "pinchy_abc",
      name: "CI",
      expiresAt: null,
    });

    await POST(
      postRequest({ name: "CI", scopes: ["agents:read", "agents:write"] }),
      routeContext()
    );

    // Two things are pinned here, and both are load-bearing:
    //
    // 1. `userId` (which the plugin stores verbatim as `referenceId`) is the
    //    ORG service account, never "admin-1". The key must not claim to
    //    carry a person's authority — it outlives them by design, so a user
    //    id there would be a claim nothing keeps true. That the key really
    //    does survive its creator's deletion is proven against a real DB in
    //    settings-api-keys-ownership.integration.test.ts.
    // 2. The admin lands in `metadata.createdBy` instead: provenance, so
    //    admins can answer "whose key is this, do we rotate it now they've
    //    left?" — the compensating control for one-time-plaintext custody.
    //
    // No `headers`/`request` field: permissions/userId are server-only fields
    // on this endpoint — passing headers would make better-auth treat this as
    // a client request and throw SERVER_ONLY_PROPERTY.
    expect(mockCreateApiKey).toHaveBeenCalledWith({
      body: {
        name: "CI",
        permissions: { agents: ["read", "write"] },
        expiresIn: undefined,
        userId: PINCHY_SERVICE_ACCOUNT_ID,
        metadata: { createdBy: { id: "admin-1", name: "Ada Admin" } },
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

    await POST(
      postRequest({ name: "CI", scopes: ["agents:read"], expiresInDays: 30 }),
      routeContext()
    );

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

    const response = await POST(
      postRequest({ name: "CI Deploy", scopes: ["agents:read"] }),
      routeContext()
    );
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
    const response = await POST(postRequest({ name: "", scopes: ["agents:read"] }), routeContext());

    expect(response.status).toBe(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 400 for empty scopes (default-deny: at least one scope required)", async () => {
    const response = await POST(postRequest({ name: "CI", scopes: [] }), routeContext());

    expect(response.status).toBe(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  it("returns 400 for an unknown/invalid scope", async () => {
    const response = await POST(
      postRequest({ name: "CI", scopes: ["agents:admin"] }),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  it("returns a clean 400 (not an uncaught 500) for expiresInDays beyond the plugin's 365-day cap", async () => {
    // @better-auth/api-key's `keyExpiration.maxExpiresIn` defaults to 365
    // (unconfigured by lib/auth.ts's `apiKey()` setup) and throws
    // EXPIRES_IN_IS_TOO_LARGE past it. Without a matching cap in THIS schema,
    // 366 would sail past validation and only fail inside
    // auth.api.createApiKey — an uncaught APIError the route doesn't handle,
    // surfacing as a 500. The schema must reject it first, same reasoning as
    // the sibling `name` cap (max 32) a few lines up.
    const response = await POST(
      postRequest({ name: "CI", scopes: ["agents:read"], expiresInDays: 366 }),
      routeContext()
    );

    expect(response.status).toBe(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
  });

  it("accepts expiresInDays at exactly the 365-day cap", async () => {
    mockCreateApiKey.mockResolvedValue({
      id: "key-1",
      key: "pinchy_abc",
      name: "CI",
      expiresAt: new Date("2027-07-15T00:00:00.000Z"),
    });

    const response = await POST(
      postRequest({ name: "CI", scopes: ["agents:read"], expiresInDays: 365 }),
      routeContext()
    );

    expect(response.status).toBe(201);
    expect(mockCreateApiKey).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ expiresIn: 365 * 86400 }) })
    );
  });

  it("returns 403 Forbidden for a non-admin session and never creates a key", async () => {
    mockGetSession.mockResolvedValue(memberSession());

    const response = await POST(
      postRequest({ name: "CI", scopes: ["agents:read"] }),
      routeContext()
    );

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
   * Sets up the GET route's two queries:
   *
   *   1. `db.select().from(apiKeys).orderBy(...)` → `rows`.
   *   2. `db.select().from(users).where(inArray(...))` → `creatorRows`, the
   *      creator-liveness lookup. Defaults to "the fixture's creator is still
   *      employed"; pass `[]` for a creator who is gone, or a `banned: true`
   *      row for one who is deactivated.
   *
   * Dispatches on the TABLE rather than call order, deliberately. Query 2 is
   * skipped entirely when no key has a recorded creator, so a call-order mock
   * would leave a queued response behind and desync every later test in the
   * file — a failure that surfaces nowhere near its cause.
   *
   * Dispatching this way also preserves the guard that motivated the original
   * shape: `.from(apiKeys)` exposes ONLY `.orderBy()`, never `.where()`, so a
   * route that regressed to filtering by the caller's own `referenceId` (i.e.
   * went back to per-admin instead of org-wide) calls a method that doesn't
   * exist here and fails loudly rather than silently narrowing.
   */
  function mockKeyRows(
    rows: unknown[],
    creatorRows: { id: string; banned: boolean }[] = [{ id: "admin-1", banned: false }]
  ) {
    const orderBy = vi.fn().mockResolvedValue(rows);
    const creatorWhere = vi.fn().mockResolvedValue(creatorRows);
    const from = vi.fn((table: unknown) =>
      table === users ? { where: creatorWhere } : { orderBy }
    );
    mockDbSelect.mockReturnValue({ from });
    return { from, orderBy, creatorWhere };
  }

  // A full apiKey row shape (matches every column in db/schema.ts's
  // `apiKeys` table) so the whitelist tests below prove real leaks, not
  // leaks of fields a hand-trimmed fixture never had in the first place.
  function fullKeyRow(overrides: Record<string, unknown> = {}) {
    return {
      id: "key-1",
      name: "CI Deploy",
      start: "pinchy_a1b2c3",
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
      metadata: JSON.stringify({ createdBy: { id: "admin-1", name: "Ada Admin" } }),
      ...overrides,
    };
  }

  it("returns 200 with a masked key list containing only the safe whitelisted fields", async () => {
    mockKeyRows([fullKeyRow()]);

    const response = await GET(getRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      keys: [
        {
          id: "key-1",
          name: "CI Deploy",
          start: "pinchy_a1b2c3",
          scopes: ["agents:read", "agents:write"],
          createdAt: "2026-01-01T00:00:00.000Z",
          expiresAt: null,
          lastRequest: null,
          enabled: true,
          // Parsed out of the raw `metadata` JSON string, never passed
          // through wholesale — see the leak test below. `active` is resolved
          // live, so this row prompts a rotation once Ada is gone.
          createdBy: { id: "admin-1", name: "Ada Admin", active: true },
        },
      ],
    });
  });

  it("renders createdBy as null for a key with no or unparseable creator metadata", async () => {
    mockKeyRows([
      fullKeyRow({ id: "key-old", metadata: null }),
      fullKeyRow({ id: "key-corrupt", metadata: "{not valid json" }),
      fullKeyRow({ id: "key-partial", metadata: JSON.stringify({ createdBy: { id: "u1" } }) }),
    ]);

    const response = await GET(getRequest(), routeContext());
    const body = await response.json();

    // Degrade honestly rather than guess or throw: one bad row must not take
    // the whole settings page down, and "unknown" must look like unknown.
    expect(body.keys.map((k: { createdBy: unknown }) => k.createdBy)).toEqual([null, null, null]);
  });

  it("queries the apikey table directly, org-wide — no per-admin filter", async () => {
    const { from } = mockKeyRows([]);

    await GET(getRequest(), routeContext());

    expect(mockDbSelect).toHaveBeenCalled();
    expect(from).toHaveBeenCalledWith(apiKeys);
  });

  it("returns keys from multiple different admins in one call (the org-wide guarantee)", async () => {
    mockKeyRows([
      fullKeyRow({ id: "key-1", name: "Admin One's key", referenceId: "admin-1" }),
      fullKeyRow({ id: "key-2", name: "Admin Two's key", referenceId: "admin-2" }),
    ]);

    const response = await GET(getRequest(), routeContext());
    const body = await response.json();

    expect(body.keys.map((k: { id: string }) => k.id)).toEqual(["key-1", "key-2"]);
  });

  it("never leaks a hashed key, raw permissions, or metadata field", async () => {
    mockKeyRows([
      fullKeyRow({
        // Defensive: even if a future refactor widened the select, the
        // route's whitelist must drop these regardless.
        key: "should-never-appear-in-response",
        // Metadata carrying BOTH the legitimate createdBy and an extra field.
        // The route must project out createdBy and drop the rest — passing
        // the parsed object through wholesale would leak whatever else a
        // future writer (or a hand-edited row) put in this column.
        metadata: JSON.stringify({
          createdBy: { id: "admin-1", name: "Ada Admin" },
          secret: "should-never-appear-in-response-either",
        }),
      }),
    ]);

    const response = await GET(getRequest(), routeContext());
    const body = await response.json();
    const bodyText = JSON.stringify(body);

    expect(bodyText).not.toContain("should-never-appear-in-response");
    expect(bodyText).not.toContain("should-never-appear-in-response-either");
    expect(body.keys[0]).not.toHaveProperty("key");
    expect(body.keys[0]).not.toHaveProperty("permissions");
    expect(body.keys[0]).not.toHaveProperty("metadata");
    expect(body.keys[0]).not.toHaveProperty("prefix");
    expect(body.keys[0]).not.toHaveProperty("referenceId");
    expect(body.keys[0].createdBy).toEqual({ id: "admin-1", name: "Ada Admin", active: true });
    // Whitelist is exhaustive: no field beyond the 9 documented safe ones.
    expect(Object.keys(body.keys[0]).sort()).toEqual(
      [
        "createdAt",
        "createdBy",
        "enabled",
        "expiresAt",
        "id",
        "lastRequest",
        "name",
        "scopes",
        "start",
      ].sort()
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

    const response = await GET(getRequest(), routeContext());
    const body = await response.json();

    // "agents:admin" and "billing:read" are not valid API_KEY_SCOPES — must
    // be dropped, not passed through as if they were granted capabilities.
    expect(body.keys[0].scopes).toEqual(["agents:read"]);
  });

  it("maps a null permissions column to an empty scopes array", async () => {
    mockKeyRows([fullKeyRow({ permissions: null })]);

    const response = await GET(getRequest(), routeContext());
    const body = await response.json();

    expect(body.keys[0].scopes).toEqual([]);
  });

  it("degrades to an empty scopes array (not a crash/500) when the permissions column is invalid JSON", async () => {
    mockKeyRows([fullKeyRow({ permissions: "{not-valid-json" })]);

    const response = await GET(getRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.keys[0].scopes).toEqual([]);
  });

  it("returns an empty keys array when there are no keys", async () => {
    mockKeyRows([]);

    const response = await GET(getRequest(), routeContext());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ keys: [] });
  });

  it("does not write an audit entry (read-only, audit-exempt)", async () => {
    mockKeyRows([]);

    await GET(getRequest(), routeContext());

    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden for a non-admin session and never queries keys", async () => {
    mockGetSession.mockResolvedValue(memberSession());

    const response = await GET(getRequest(), routeContext());

    expect(response.status).toBe(403);
    expect(mockDbSelect).not.toHaveBeenCalled();
  });
});
