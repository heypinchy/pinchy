/**
 * Unit tests for `withApiKey` — the scope-gated API-key auth wrapper that
 * guards the Agent Provisioning API (#572).
 *
 * This wrapper is the security core of the feature, so the suite is
 * fail-closed focused: every path that is not an explicitly authenticated
 * AND authorized request must deny (401/403) and must NOT invoke the wrapped
 * handler.
 *
 * `auth.api.verifyApiKey` is mocked so these tests exercise OUR wrapper logic
 * (header parsing, scope gating, context shaping, fail-closed behavior) — not
 * better-auth's key verification.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const { mockVerifyApiKey, mockHeaders } = vi.hoisted(() => ({
  mockVerifyApiKey: vi.fn(),
  mockHeaders: vi.fn().mockResolvedValue(new Headers()),
}));

// `api-auth.ts` imports BOTH `getSession` (used by the session wrappers) and
// `auth` (used by `withApiKey` → `auth.api.verifyApiKey`) from `@/lib/auth`.
// The factory must export both so importing the module never yields
// `undefined` — mirroring the shared mock in `api-auth.test.ts`.
vi.mock("@/lib/auth", () => ({
  getSession: vi.fn(),
  auth: {
    api: {
      verifyApiKey: mockVerifyApiKey,
    },
  },
}));

vi.mock("next/headers", () => ({
  headers: mockHeaders,
}));

import { withApiKey, type ApiKeyContext } from "@/lib/api-auth";
import { extractScopes } from "@/lib/api-key-scopes";

// ── Helpers ─────────────────────────────────────────────────────────────

function reqWith(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://localhost/api/agents", { headers });
}

/** A successful verifyApiKey result with overridable `key` fields. */
function verified(key: Record<string, unknown> = {}) {
  return {
    valid: true,
    error: null,
    key: {
      id: "key-1",
      name: "CI Deploy Key",
      referenceId: "user-42",
      permissions: { agents: ["read", "write"] },
      ...key,
    },
  };
}

const OK = () => NextResponse.json({ ok: true });

describe("withApiKey", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns 401 Unauthorized when no key header is present", async () => {
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(reqWith({}), {});

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(handler).not.toHaveBeenCalled();
    // Fail fast: never even reach key verification without a key.
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
  });

  it("returns 401 Unauthorized when the key is invalid", async () => {
    mockVerifyApiKey.mockResolvedValue({
      valid: false,
      error: { message: "invalid", code: "INVALID_API_KEY" },
      key: null,
    });
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_bad" }),
      {}
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("returns 403 Forbidden when a valid key is missing a required scope", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ permissions: { agents: ["read"] } }));
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:write"], handler)(
      reqWith({ Authorization: "Bearer pinchy_readonly" }),
      {}
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires ALL scopes (AND, not OR): denies a key holding only some of them", async () => {
    // Guards against a `.some()` regression: with a single required scope,
    // AND and OR are indistinguishable — this needs ≥2 required scopes.
    mockVerifyApiKey.mockResolvedValue(verified({ permissions: { agents: ["read"] } }));
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read", "agents:write"], handler)(
      reqWith({ Authorization: "Bearer pinchy_readonly" }),
      {}
    );

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "Forbidden" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("requires ALL scopes (AND, not OR): allows a key holding every required scope", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ permissions: { agents: ["read", "write"] } }));
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read", "agents:write"], handler)(
      reqWith({ Authorization: "Bearer pinchy_rw" }),
      {}
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("calls the handler with apiKeyContext when the key has the required scope", async () => {
    mockVerifyApiKey.mockResolvedValue(
      verified({
        id: "key-77",
        name: "Deploy Bot",
        referenceId: "user-99",
        permissions: { agents: ["read", "write"] },
      })
    );
    const handler = vi.fn((_req, _ctx, key: ApiKeyContext) => NextResponse.json({ key }));

    const req = reqWith({ Authorization: "Bearer pinchy_good" });
    const ctx = { params: Promise.resolve({}) };
    const res = await withApiKey(["agents:read"], handler)(req, ctx);

    expect(res.status).toBe(200);
    expect(mockVerifyApiKey).toHaveBeenCalledWith({ body: { key: "pinchy_good" } });
    expect(handler).toHaveBeenCalledTimes(1);

    // Handler receives (req, ctx, apiKeyContext) — same req/ctx instances.
    const [passedReq, passedCtx, apiKeyContext] = handler.mock.calls[0];
    expect(passedReq).toBe(req);
    expect(passedCtx).toBe(ctx);
    expect(apiKeyContext).toEqual({
      keyId: "key-77",
      name: "Deploy Bot",
      scopes: ["agents:read", "agents:write"],
      // issuerUserId is the key owner — better-auth exposes it as referenceId.
      issuerUserId: "user-99",
    });
  });

  it("allows a key whose scopes are a superset of what the route requires", async () => {
    mockVerifyApiKey.mockResolvedValue(
      verified({ permissions: { agents: ["read", "write", "delete"] } })
    );
    const handler = vi.fn((_req, _ctx, key: ApiKeyContext) =>
      NextResponse.json({ scopes: key.scopes })
    );

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_all" }),
      {}
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await res.json()).toEqual({
      scopes: ["agents:read", "agents:write", "agents:delete"],
    });
  });

  it("reads the key from the x-api-key header when no Bearer token is present", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ permissions: { agents: ["read"] } }));
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ "x-api-key": "pinchy_via_header" }),
      {}
    );

    expect(res.status).toBe(200);
    expect(mockVerifyApiKey).toHaveBeenCalledWith({ body: { key: "pinchy_via_header" } });
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("prefers the Authorization Bearer header over x-api-key", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ permissions: { agents: ["read"] } }));
    const handler = vi.fn(OK);

    await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_bearer", "x-api-key": "pinchy_header" }),
      {}
    );

    expect(mockVerifyApiKey).toHaveBeenCalledWith({ body: { key: "pinchy_bearer" } });
  });

  it("fails closed (401) when verifyApiKey unexpectedly throws", async () => {
    // verifyApiKey catches internally today, but a malformed input or a future
    // plugin version must never fall through as authenticated.
    mockVerifyApiKey.mockRejectedValue(new Error("boom"));
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_x" }),
      {}
    );

    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("fails closed (401) when verifyApiKey reports valid but returns a null key", async () => {
    mockVerifyApiKey.mockResolvedValue({ valid: true, error: null, key: null });
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_x" }),
      {}
    );

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });
});

// ── extractScopes (permissions → scope strings) ─────────────────────────

describe("extractScopes", () => {
  it("returns [] for null or undefined permissions", () => {
    expect(extractScopes(null)).toEqual([]);
    expect(extractScopes(undefined)).toEqual([]);
  });

  it("flattens { resource: [action, ...] } into resource:action strings", () => {
    expect(extractScopes({ agents: ["read", "write", "delete"] })).toEqual([
      "agents:read",
      "agents:write",
      "agents:delete",
    ]);
  });

  it("drops permissions that are not valid API_KEY_SCOPES", () => {
    // `agents:admin` is an unknown action; `billing:read` is an unknown
    // resource — both must be dropped so the result stays honestly typed.
    expect(extractScopes({ agents: ["read", "admin"], billing: ["read"] })).toEqual([
      "agents:read",
    ]);
  });

  it("returns [] for malformed permission values (non-array actions)", () => {
    // Drives the `Array.isArray` guard: a non-array `actions` value must be
    // skipped, not iterated (which would throw).
    expect(extractScopes({ agents: "read" as unknown as string[] })).toEqual([]);
    expect(extractScopes({ agents: null as unknown as string[] })).toEqual([]);
  });
});
