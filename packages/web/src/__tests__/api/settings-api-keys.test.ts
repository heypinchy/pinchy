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
 * `auth.api.createApiKey` / `auth.api.listApiKeys` are mocked — this suite
 * exercises the ROUTE's job (auth, validation, one-time plaintext handling,
 * audit actor/detail shape, and the response masking whitelist), not
 * better-auth's own plugin logic (already covered by
 * auth-apikey.integration.test.ts).
 */

const { mockGetSession, mockCreateApiKey, mockListApiKeys } = vi.hoisted(() => ({
  mockGetSession: vi.fn(),
  mockCreateApiKey: vi.fn(),
  mockListApiKeys: vi.fn(),
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
      listApiKeys: mockListApiKeys,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: vi.fn().mockResolvedValue(new Headers()),
}));

vi.mock("@/lib/audit", () => ({
  appendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

import { POST, GET } from "@/app/api/settings/api-keys/route";
import { appendAuditLog } from "@/lib/audit";

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

  it("returns 200 with a masked key list containing only the safe whitelisted fields", async () => {
    mockListApiKeys.mockResolvedValue({
      apiKeys: [
        {
          id: "key-1",
          name: "CI Deploy",
          start: "pinchy_abc",
          prefix: "pinchy_",
          permissions: { agents: ["read", "write"] },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: null,
          lastRequest: null,
          enabled: true,
          referenceId: "admin-1",
          metadata: null,
        },
      ],
      total: 1,
      limit: undefined,
      offset: undefined,
    });

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

  it("never leaks a hashed key, raw permissions, or metadata field", async () => {
    mockListApiKeys.mockResolvedValue({
      apiKeys: [
        {
          id: "key-1",
          name: "CI Deploy",
          start: "pinchy_abc",
          prefix: "pinchy_",
          // Defensive: even if the plugin's list endpoint ever regressed and
          // included the hashed key, the route's whitelist must drop it.
          key: "should-never-appear-in-response",
          permissions: { agents: ["read"] },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: null,
          lastRequest: null,
          enabled: true,
          referenceId: "admin-1",
          metadata: { secret: "nope" },
        },
      ],
      total: 1,
    });

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

  it("maps stored permissions to scopes via extractScopes, dropping unknown grants", async () => {
    mockListApiKeys.mockResolvedValue({
      apiKeys: [
        {
          id: "key-1",
          name: "K1",
          start: null,
          permissions: { agents: ["read", "admin"], billing: ["read"] },
          createdAt: new Date("2026-01-01T00:00:00.000Z"),
          expiresAt: null,
          lastRequest: null,
          enabled: true,
        },
      ],
      total: 1,
    });

    const response = await GET(getRequest());
    const body = await response.json();

    // "agents:admin" and "billing:read" are not valid API_KEY_SCOPES — must
    // be dropped, not passed through as if they were granted capabilities.
    expect(body.keys[0].scopes).toEqual(["agents:read"]);
  });

  it("returns an empty keys array when there are no keys", async () => {
    mockListApiKeys.mockResolvedValue({ apiKeys: [], total: 0 });

    const response = await GET(getRequest());
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({ keys: [] });
  });

  it("does not write an audit entry (read-only, audit-exempt)", async () => {
    mockListApiKeys.mockResolvedValue({ apiKeys: [], total: 0 });

    await GET(getRequest());

    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden for a non-admin session and never lists keys", async () => {
    mockGetSession.mockResolvedValue(memberSession());

    const response = await GET(getRequest());

    expect(response.status).toBe(403);
    expect(mockListApiKeys).not.toHaveBeenCalled();
  });
});
