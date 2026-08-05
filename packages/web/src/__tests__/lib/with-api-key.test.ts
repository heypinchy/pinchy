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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

vi.mock("@/lib/audit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/audit")>();
  return {
    ...actual,
    // safeAuditPath stays REAL: it's pure, and the path-cap test below asserts
    // its actual output. Stubbing it would assert the stub.
    appendAuditLog: vi.fn().mockResolvedValue(undefined),
  };
});

import { withApiKey, resetScopeDenialWindows, type ApiKeyContext } from "@/lib/api-auth";
import { extractScopes } from "@/lib/api-key-scopes";
import { appendAuditLog } from "@/lib/audit";
import {
  claimApiKeyRequest,
  resetApiKeyRateLimits,
  API_KEY_RATE_LIMIT_MAX,
} from "@/lib/api-key-rate-limit";

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
    // The scope-denial windows are process-global, so a previous test's key
    // would otherwise still hold an open window and swallow this one's row.
    resetScopeDenialWindows();
    // Same for the request budgets: a key left exhausted by a previous test
    // would 429 here, several assertions before the one that failed.
    resetApiKeyRateLimits();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
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
        // The real value is the constant service-account id; a user-shaped
        // string here is the harsher fixture, since it's what a regression
        // would produce and what the assertion below must still refuse.
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
    // Exact-match, and the ABSENCE is what's load-bearing: the context carries
    // no user, not even though `referenceId` is populated above. A key belongs
    // to the org, not to whoever created it (lib/api-key-identity.ts), so
    // there's no person for a route to attribute its actions to — the key is
    // the actor (design D2). Passing a user field through here is what would
    // let that attribution creep back into the audit trail.
    expect(apiKeyContext).toEqual({
      keyId: "key-77",
      name: "Deploy Bot",
      scopes: ["agents:read", "agents:write"],
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

  // ── Keys the plugin rejects on its own terms ────────────────────────────

  it("denies an EXPIRED key (401) and never calls the handler", async () => {
    // What the plugin actually returns for an expired key: valid:false with a
    // reason, not a throw. The wrapper keys off `valid`, so it denies — but
    // nothing proved that until now, and "the expiry field is honoured" is
    // the entire promise behind offering an expiry in the UI.
    mockVerifyApiKey.mockResolvedValue({
      valid: false,
      error: { code: "KEY_EXPIRED", message: "API Key has expired" },
      key: null,
    });
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_expired" }),
      {}
    );

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("denies a DISABLED key (401) and never calls the handler", async () => {
    mockVerifyApiKey.mockResolvedValue({
      valid: false,
      error: { code: "KEY_DISABLED", message: "API Key is disabled" },
      key: null,
    });
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_disabled" }),
      {}
    );

    expect(res.status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it("accepts the Bearer scheme in any case — RFC 7235 makes it case-insensitive", async () => {
    mockVerifyApiKey.mockResolvedValue(verified());
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "bearer pinchy_lowercase" }),
      {}
    );

    // Matching "Bearer " case-sensitively failed closed — it fell through to
    // x-api-key, found nothing, and 401'd — so this was never unsafe. It just
    // told someone hand-writing curl that their key was bad when it wasn't.
    expect(res.status).toBe(200);
    expect(mockVerifyApiKey).toHaveBeenCalledWith({ body: { key: "pinchy_lowercase" } });
  });

  it("treats a vacuous 'Bearer ' header as no key at all, without calling verifyApiKey", async () => {
    // `readApiKey` slices 7 chars off "Bearer ", yielding "". Empty string is
    // falsy, so this must short-circuit to 401 rather than hand "" to the
    // plugin — which would then be a length check away from who-knows-what.
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer " }),
      {}
    );

    expect(res.status).toBe(401);
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects a key of the wrong shape without paying for verification (#1086)", async () => {
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      // What a credential scanner actually sprays at a public endpoint:
      // somebody else's token format.
      reqWith({ Authorization: "Bearer sk-live-4eC39HqLyjWDarjtT1zdp7dc" }),
      {}
    );

    expect(res.status).toBe(401);
    // The assertion that matters. `verifyApiKey` hashes the candidate and hits
    // the database, and /api/v1/* is reachable by anyone — so a string that
    // cannot be one of our keys must not buy a round trip. Dropping this check
    // would not fail any other test in this file: every one of them would
    // still answer 401, just after the work.
    expect(mockVerifyApiKey).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it("still verifies a correctly shaped key — the filter must not become the gate", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ permissions: { agents: ["read"] } }));
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_correctly_shaped" }),
      {}
    );

    // The shape check says a string is NOT one of ours, never that it is.
    // A well-formed string still has to verify.
    expect(mockVerifyApiKey).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  // ── Auditing denials (#572) ─────────────────────────────────────────────

  it("audits a scope denial with the key as actor and what it tried to do", async () => {
    mockVerifyApiKey.mockResolvedValue(
      verified({ id: "key-9", name: "Read-only bot", permissions: { agents: ["read"] } })
    );
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:delete"], handler)(
      reqWith({ Authorization: "Bearer pinchy_readonly" }),
      {}
    );

    expect(res.status).toBe(403);
    // A key reaching for a scope it wasn't granted is exactly the signal a
    // security team wants: either a misconfigured client or a stolen key
    // being probed. Both worth a row.
    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "api_key",
      actorId: "key-9",
      eventType: "auth.scope_denied",
      outcome: "failure",
      detail: {
        apiKey: { id: "key-9", name: "Read-only bot" },
        required: ["agents:delete"],
        held: ["agents:read"],
        path: "/api/agents",
      },
    });
  });

  // The comment this replaces claimed the denial row was "bounded, too — the
  // caller holds a real key, so this can't be spammed by just anyone", then
  // three lines later used the opposite argument to refuse auditing 401s.
  // Holding a real key bounds nothing on its own: the schema's floor is ONE
  // scope, so an agents:read key can loop DELETE. Since #1086 the per-key
  // budget does bound how fast — but the two throttles are independent, and
  // this one has to hold at any rate below the budget.

  it("writes ONE denial row per key per window, however hard the key is probed", async () => {
    mockVerifyApiKey.mockResolvedValue(
      verified({ id: "key-flood", name: "Read-only bot", permissions: { agents: ["read"] } })
    );
    const handler = vi.fn(OK);
    const probe = () =>
      withApiKey(["agents:delete"], handler)(reqWith({ Authorization: "Bearer pinchy_ro" }), {});

    for (let i = 0; i < 50; i++) {
      expect((await probe()).status).toBe(403);
    }

    // Every request is still denied — throttling the RECORD must never soften
    // the DECISION.
    expect(handler).not.toHaveBeenCalled();
    // ...but 50 probes are one row, not 50. Otherwise a stolen read-only key
    // buries the very denials this row exists to surface.
    expect(appendAuditLog).toHaveBeenCalledTimes(1);
  });

  it("reports the denials it collapsed rather than dropping them silently", async () => {
    mockVerifyApiKey.mockResolvedValue(
      verified({ id: "key-flood", name: "Read-only bot", permissions: { agents: ["read"] } })
    );
    const probe = () =>
      withApiKey(["agents:delete"], vi.fn(OK))(reqWith({ Authorization: "Bearer pinchy_ro" }), {});

    await probe(); // opens the window, writes row 1
    await probe();
    await probe(); // two suppressed

    vi.advanceTimersByTime(61_000); // the window elapses
    await probe(); // writes row 2

    const [, second] = vi.mocked(appendAuditLog).mock.calls;
    // A cap nobody can see reads as "one stray call" when it was a flood.
    expect((second[0] as { detail: Record<string, unknown> }).detail).toMatchObject({
      suppressedSinceLastEntry: 2,
    });
  });

  it("omits the suppressed count when nothing was suppressed", async () => {
    mockVerifyApiKey.mockResolvedValue(
      verified({ id: "key-quiet", name: "Read-only bot", permissions: { agents: ["read"] } })
    );

    await withApiKey(["agents:delete"], vi.fn(OK))(
      reqWith({ Authorization: "Bearer pinchy_ro" }),
      {}
    );

    const detail = vi.mocked(appendAuditLog).mock.calls[0][0].detail as Record<string, unknown>;
    expect(detail).not.toHaveProperty("suppressedSinceLastEntry");
  });

  it("throttles per key, so one noisy key can't mask another's denial", async () => {
    const handler = vi.fn(OK);
    mockVerifyApiKey.mockResolvedValue(
      verified({ id: "key-noisy", name: "Noisy", permissions: { agents: ["read"] } })
    );
    await withApiKey(["agents:delete"], handler)(reqWith({ Authorization: "Bearer pinchy_a" }), {});
    await withApiKey(["agents:delete"], handler)(reqWith({ Authorization: "Bearer pinchy_a" }), {});

    mockVerifyApiKey.mockResolvedValue(
      verified({ id: "key-other", name: "Other", permissions: { agents: ["read"] } })
    );
    await withApiKey(["agents:delete"], handler)(reqWith({ Authorization: "Bearer pinchy_b" }), {});

    // A shared window would let a flood from one key swallow the first — and
    // only — denial from another. Two keys, two rows.
    expect(appendAuditLog).toHaveBeenCalledTimes(2);
    expect(vi.mocked(appendAuditLog).mock.calls.map(([e]) => e.actorId)).toEqual([
      "key-noisy",
      "key-other",
    ]);
  });

  it("caps the caller-controlled path so truncation can't strip the row's actor", async () => {
    mockVerifyApiKey.mockResolvedValue(
      verified({ id: "key-long", name: "Read-only bot", permissions: { agents: ["read"] } })
    );

    const longPath = "/api/v1/agents/" + "A".repeat(4000);
    await withApiKey(["agents:delete"], vi.fn(OK))(
      new NextRequest(`http://localhost${longPath}`, {
        headers: { Authorization: "Bearer pinchy_ro" },
      }),
      {}
    );

    const detail = vi.mocked(appendAuditLog).mock.calls[0][0].detail as Record<string, unknown>;
    // truncateDetail replaces the WHOLE detail object once it's over budget —
    // it does not trim the offending field. An uncapped path would take the
    // apiKey snapshot with it, blanking the Actor column on exactly the rows
    // that document a key being probed. Capping at the source keeps it.
    expect((detail.path as string).length).toBeLessThanOrEqual(256);
    expect(detail.apiKey).toEqual({ id: "key-long", name: "Read-only bot" });
  });

  it("does NOT audit an unauthenticated 401 — that's an unauthenticated write into the audit table", async () => {
    mockVerifyApiKey.mockResolvedValue({ valid: false, error: null, key: null });
    const handler = vi.fn(OK);

    const noKey = await withApiKey(["agents:read"], handler)(reqWith({}), {});
    const badKey = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_garbage" }),
      {}
    );

    expect(noKey.status).toBe(401);
    expect(badKey.status).toBe(401);
    // DELIBERATE asymmetry with the 403 above. Anyone on the internet can hit
    // /api/v1/* with a garbage key, so auditing these would hand an
    // unauthenticated attacker an unbounded write into the audit table — a
    // log-flooding amplifier that buries the real 403s above. There's also
    // nothing to attribute: a key that fails verification has no id.
    //
    // #1086's per-key budget does NOT change this, and it is worth being exact
    // about why: it is charged against a verified key id, so it bounds what an
    // authenticated caller can do and touches this path not at all. The shape
    // check above spares a wrongly-shaped key the database lookup, but a
    // well-formed wrong key still arrives here unbounded.
    expect(appendAuditLog).not.toHaveBeenCalled();
  });

  it("still denies when the audit write throws — logging must never gate authorization", async () => {
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("audit db down"));
    mockVerifyApiKey.mockResolvedValue(verified({ permissions: { agents: ["read"] } }));
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:delete"], handler)(
      reqWith({ Authorization: "Bearer pinchy_readonly" }),
      {}
    );

    // Fail closed in both directions: the audit failure must neither open the
    // gate nor turn a clean 403 into an unhandled 500.
    expect(res.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  // ── Per-key request budget (#1086) ──────────────────────────────────────
  //
  // The window arithmetic itself is pinned deterministically in
  // api-key-rate-limit.test.ts, which injects `now`. What these tests own is
  // the translation: does the wrapper consult the limiter on every request,
  // and does a rejection become a 429 with a usable Retry-After and a row?

  /** Spends the whole budget for `keyId` without going through the wrapper. */
  function exhaustBudget(keyId: string): void {
    for (let i = 0; i < API_KEY_RATE_LIMIT_MAX; i++) claimApiKeyRequest(keyId);
  }

  it("counts every served request, and answers 429 once the key's budget is spent", async () => {
    // Driven through the wrapper rather than seeded, deliberately: a wrapper
    // that consults the limiter but never charges a SUCCESSFUL request would
    // pass every seeded test below while throttling nothing in production.
    mockVerifyApiKey.mockResolvedValue(
      verified({ id: "key-busy", name: "Busy", permissions: { agents: ["read"] } })
    );
    const handler = vi.fn(OK);
    const call = () =>
      withApiKey(["agents:read"], handler)(reqWith({ Authorization: "Bearer pinchy_busy" }), {});

    for (let i = 0; i < API_KEY_RATE_LIMIT_MAX; i++) {
      expect((await call()).status).toBe(200);
    }

    const res = await call();

    expect(res.status).toBe(429);
    expect(await res.json()).toEqual({ error: "Too Many Requests" });
    // The handler ran for the budget and not once more — a 429 that still
    // reaches the handler is a limiter in name only.
    expect(handler).toHaveBeenCalledTimes(API_KEY_RATE_LIMIT_MAX);
  });

  it("tells the client when to come back, in seconds", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ id: "key-r", name: "R" }));
    exhaustBudget("key-r");

    const res = await withApiKey(["agents:read"], vi.fn(OK))(
      reqWith({ Authorization: "Bearer pinchy_r" }),
      {}
    );

    // Bounds rather than an exact value: the window opened a few real
    // milliseconds ago (the timers advance), and the exact arithmetic is
    // already pinned deterministically in api-key-rate-limit.test.ts. What
    // must hold here is that the header exists and is usable — a missing or
    // zero Retry-After sends a well-behaved client straight back into the wall.
    const retryAfter = Number(res.headers.get("Retry-After"));
    expect(Number.isInteger(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
    expect(retryAfter).toBeLessThanOrEqual(60);
  });

  it("budgets per key, so one runaway client cannot lock out another", async () => {
    exhaustBudget("key-runaway");

    mockVerifyApiKey.mockResolvedValue(verified({ id: "key-runaway", name: "Runaway" }));
    const throttled = await withApiKey(["agents:read"], vi.fn(OK))(
      reqWith({ Authorization: "Bearer pinchy_runaway" }),
      {}
    );

    mockVerifyApiKey.mockResolvedValue(verified({ id: "key-innocent", name: "Innocent" }));
    const handler = vi.fn(OK);
    const unaffected = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_innocent" }),
      {}
    );

    expect(throttled.status).toBe(429);
    // The reason the bucket is keyed on the VERIFIED key id: a global bucket
    // would let one client's retry loop take the whole instance's API down,
    // and a bucket keyed on a caller-supplied header would not bound anything.
    expect(unaffected.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("throttles ahead of the scope check, so a denied key cannot spin forever", async () => {
    mockVerifyApiKey.mockResolvedValue(
      verified({ id: "key-probe", name: "Probe", permissions: { agents: ["read"] } })
    );
    exhaustBudget("key-probe");
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:delete"], handler)(
      reqWith({ Authorization: "Bearer pinchy_probe" }),
      {}
    );

    // 429, not 403: a key probing a scope it doesn't hold is exactly the
    // caller this bounds, and answering 403 forever would leave the probe
    // itself unbounded — the audit row is throttled, the requests were not.
    expect(res.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
    expect(vi.mocked(appendAuditLog).mock.calls.map(([e]) => e.eventType)).toEqual([
      "auth.rate_limited",
    ]);
  });

  it("audits the throttle with the key as actor and the limit it hit", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ id: "key-a", name: "Audited key" }));
    exhaustBudget("key-a");

    await withApiKey(["agents:read"], vi.fn(OK))(
      new NextRequest("http://localhost/api/v1/agents", {
        headers: { Authorization: "Bearer pinchy_a" },
      }),
      {}
    );

    expect(appendAuditLog).toHaveBeenCalledWith({
      actorType: "api_key",
      actorId: "key-a",
      eventType: "auth.rate_limited",
      outcome: "failure",
      detail: {
        // Snapshotted beside the id: the key may be revoked, and its row hard
        // deleted, long before anyone reads this.
        apiKey: { id: "key-a", name: "Audited key" },
        limit: { max: API_KEY_RATE_LIMIT_MAX, windowSeconds: 60 },
        path: "/api/v1/agents",
      },
    });
  });

  it("writes ONE throttle row per key per window, and reports what it collapsed", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ id: "key-flood2", name: "Flood" }));
    exhaustBudget("key-flood2");
    const call = () =>
      withApiKey(["agents:read"], vi.fn(OK))(reqWith({ Authorization: "Bearer pinchy_f" }), {});

    for (let i = 0; i < 20; i++) {
      expect((await call()).status).toBe(429);
    }

    // A row per throttled request would turn the limiter into the very
    // log-flooding amplifier it exists to prevent.
    expect(appendAuditLog).toHaveBeenCalledTimes(1);
    expect(
      (vi.mocked(appendAuditLog).mock.calls[0][0].detail as Record<string, unknown>)
        .suppressedSinceLastEntry
    ).toBeUndefined();

    vi.advanceTimersByTime(61_000); // the window elapses
    for (let i = 0; i < API_KEY_RATE_LIMIT_MAX; i++) await call(); // spend it again
    await call();

    const [, second] = vi.mocked(appendAuditLog).mock.calls;
    expect((second[0] as { detail: Record<string, unknown> }).detail).toMatchObject({
      suppressedSinceLastEntry: 19,
    });
  });

  it("caps the caller-controlled path on the throttle row too", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ id: "key-lp", name: "Long path" }));
    exhaustBudget("key-lp");

    await withApiKey(["agents:read"], vi.fn(OK))(
      new NextRequest(`http://localhost/api/v1/agents/${"A".repeat(4000)}`, {
        headers: { Authorization: "Bearer pinchy_lp" },
      }),
      {}
    );

    const detail = vi.mocked(appendAuditLog).mock.calls[0][0].detail as Record<string, unknown>;
    // Same reason as the scope-denial row: truncateDetail replaces the WHOLE
    // detail object, so an uncapped path would blank the actor snapshot on
    // exactly the rows that document a key being drained.
    expect((detail.path as string).length).toBeLessThanOrEqual(256);
    expect(detail.apiKey).toEqual({ id: "key-lp", name: "Long path" });
  });

  it("still throttles when the audit write throws — logging must never gate the limit", async () => {
    vi.mocked(appendAuditLog).mockRejectedValueOnce(new Error("audit db down"));
    mockVerifyApiKey.mockResolvedValue(verified({ id: "key-ad", name: "Audit down" }));
    exhaustBudget("key-ad");
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_ad" }),
      {}
    );

    // Fail closed in both directions, exactly as the scope denial does: a
    // broken audit DB must neither open the gate nor turn a clean 429 into an
    // unhandled 500.
    expect(res.status).toBe(429);
    expect(handler).not.toHaveBeenCalled();
  });

  it("leaves ordinary traffic alone — no 429, no row, no Retry-After", async () => {
    mockVerifyApiKey.mockResolvedValue(verified({ id: "key-normal", name: "Normal" }));
    const handler = vi.fn(OK);

    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_normal" }),
      {}
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("Retry-After")).toBeNull();
    expect(appendAuditLog).not.toHaveBeenCalled();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("does not charge the budget for a request that never authenticated", async () => {
    // A 401 leaves no key id to bill, so an unauthenticated flood must not be
    // able to spend a real key's budget. Nothing to assert on the 401 itself —
    // the proof is that the real key still has its full budget afterwards.
    mockVerifyApiKey.mockResolvedValue({ valid: false, error: null, key: null });
    for (let i = 0; i < 10; i++) {
      await withApiKey(["agents:read"], vi.fn(OK))(
        reqWith({ Authorization: "Bearer pinchy_garbage" }),
        {}
      );
    }

    mockVerifyApiKey.mockResolvedValue(verified({ id: "key-victim", name: "Victim" }));
    const handler = vi.fn(OK);
    const res = await withApiKey(["agents:read"], handler)(
      reqWith({ Authorization: "Bearer pinchy_victim" }),
      {}
    );

    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
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
