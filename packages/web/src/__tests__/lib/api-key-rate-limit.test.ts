/**
 * Unit tests for the per-key request limiter behind `/api/v1/*` (#1086).
 *
 * The limiter is the state machine; `withApiKey` only translates its verdict
 * into a 429 and an audit row (see with-api-key.test.ts for that half). Both
 * halves matter, and they fail differently: a wrong verdict throttles a
 * legitimate client, a wrong translation loses the row that says so.
 *
 * `now` is injected on every call rather than read from the clock, so these
 * tests state window boundaries as arithmetic instead of as sleeps.
 */
import { describe, it, expect, beforeEach } from "vitest";

import {
  claimApiKeyRequest,
  resetApiKeyRateLimits,
  trackedApiKeyCount,
  API_KEY_RATE_LIMIT_MAX,
  API_KEY_RATE_LIMIT_WINDOW_MS,
} from "@/lib/api-key-rate-limit";

const T0 = 1_700_000_000_000;

/** Spends `n` requests for `keyId` at `now`, returning the last verdict. */
function spend(keyId: string, n: number, now: number) {
  let last = claimApiKeyRequest(keyId, now);
  for (let i = 1; i < n; i++) {
    last = claimApiKeyRequest(keyId, now);
  }
  return last;
}

describe("claimApiKeyRequest", () => {
  beforeEach(() => {
    // Process-global state, exactly like the scope-denial windows next door:
    // without this a previous test's key still holds an open window.
    resetApiKeyRateLimits();
  });

  it("allows the configured budget and rejects the request after it", () => {
    for (let i = 0; i < API_KEY_RATE_LIMIT_MAX; i++) {
      expect(claimApiKeyRequest("key-1", T0)).toEqual({ allowed: true });
    }

    const verdict = claimApiKeyRequest("key-1", T0);

    expect(verdict.allowed).toBe(false);
  });

  it("budgets each key separately, so one noisy client cannot throttle another", () => {
    spend("noisy", API_KEY_RATE_LIMIT_MAX, T0);
    expect(claimApiKeyRequest("noisy", T0).allowed).toBe(false);

    // The whole point of keying on the VERIFIED key id: a second key's budget
    // is untouched. A global bucket would deny this one.
    expect(claimApiKeyRequest("quiet", T0)).toEqual({ allowed: true });
  });

  it("reopens the budget once the window has elapsed", () => {
    spend("key-1", API_KEY_RATE_LIMIT_MAX, T0);
    expect(claimApiKeyRequest("key-1", T0).allowed).toBe(false);

    // One millisecond short of the window is still the same window.
    expect(claimApiKeyRequest("key-1", T0 + API_KEY_RATE_LIMIT_WINDOW_MS - 1).allowed).toBe(false);

    expect(claimApiKeyRequest("key-1", T0 + API_KEY_RATE_LIMIT_WINDOW_MS)).toEqual({
      allowed: true,
    });
  });

  it("reports Retry-After as the time left in the window, rounded up", () => {
    spend("key-1", API_KEY_RATE_LIMIT_MAX, T0);

    // 30s into a 60s window → 30s left.
    const mid = claimApiKeyRequest("key-1", T0 + 30_000);
    expect(mid.allowed).toBe(false);
    if (mid.allowed) throw new Error("unreachable");
    expect(mid.retryAfterSeconds).toBe(30);

    // 500ms of a second left rounds UP: a client that retries after the
    // rounded-down value arrives inside the same window and is denied again.
    const nearlyOver = claimApiKeyRequest("key-1", T0 + API_KEY_RATE_LIMIT_WINDOW_MS - 500);
    if (nearlyOver.allowed) throw new Error("unreachable");
    expect(nearlyOver.retryAfterSeconds).toBe(1);
  });

  it("never reports Retry-After: 0, which a client would read as 'retry now'", () => {
    spend("key-1", API_KEY_RATE_LIMIT_MAX, T0);

    const verdict = claimApiKeyRequest("key-1", T0 + API_KEY_RATE_LIMIT_WINDOW_MS - 1);

    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("audits the first rejection of a window and suppresses the rest", () => {
    spend("key-1", API_KEY_RATE_LIMIT_MAX, T0);

    const first = claimApiKeyRequest("key-1", T0);
    if (first.allowed) throw new Error("unreachable");
    expect(first.audit).toBe(true);
    expect(first.suppressed).toBe(0);

    for (let i = 0; i < 5; i++) {
      const next = claimApiKeyRequest("key-1", T0);
      if (next.allowed) throw new Error("unreachable");
      expect(next.audit).toBe(false);
    }
  });

  it("carries the suppressed count into the next audited row rather than dropping it", () => {
    spend("key-1", API_KEY_RATE_LIMIT_MAX, T0);
    claimApiKeyRequest("key-1", T0); // audited, suppressed: 0
    for (let i = 0; i < 7; i++) claimApiKeyRequest("key-1", T0); // suppressed

    // Next window: the budget reopens, is spent again, and the first rejection
    // reports the seven rejections that never got a row of their own. A silent
    // drop would read as "one stray call" when it was eight.
    const t1 = T0 + API_KEY_RATE_LIMIT_WINDOW_MS;
    spend("key-1", API_KEY_RATE_LIMIT_MAX, t1);

    const next = claimApiKeyRequest("key-1", t1);
    if (next.allowed) throw new Error("unreachable");
    expect(next.audit).toBe(true);
    expect(next.suppressed).toBe(7);
  });

  it("does not re-report a suppressed count that has already been written", () => {
    spend("key-1", API_KEY_RATE_LIMIT_MAX, T0);
    claimApiKeyRequest("key-1", T0);
    claimApiKeyRequest("key-1", T0); // one suppressed

    const t1 = T0 + API_KEY_RATE_LIMIT_WINDOW_MS;
    spend("key-1", API_KEY_RATE_LIMIT_MAX, t1);
    const reported = claimApiKeyRequest("key-1", t1);
    if (reported.allowed) throw new Error("unreachable");
    expect(reported.suppressed).toBe(1);

    const t2 = t1 + API_KEY_RATE_LIMIT_WINDOW_MS;
    spend("key-1", API_KEY_RATE_LIMIT_MAX, t2);
    const afterwards = claimApiKeyRequest("key-1", t2);
    if (afterwards.allowed) throw new Error("unreachable");
    expect(afterwards.suppressed).toBe(0);
  });

  it("drops settled entries once their window is over, so revoked keys do not accumulate", () => {
    for (let i = 0; i < 20; i++) claimApiKeyRequest(`key-${i}`, T0);
    expect(trackedApiKeyCount()).toBe(20);

    // The sweep is amortized to at most once per window, so it runs on the
    // first call after one has elapsed — not on every call.
    claimApiKeyRequest("key-0", T0 + API_KEY_RATE_LIMIT_WINDOW_MS + 1);

    expect(trackedApiKeyCount()).toBe(1);
  });

  it("keeps an elapsed entry that still owes a suppressed count", () => {
    spend("owes", API_KEY_RATE_LIMIT_MAX, T0);
    claimApiKeyRequest("owes", T0); // audited
    claimApiKeyRequest("owes", T0); // suppressed, not yet reported
    claimApiKeyRequest("settled", T0);

    claimApiKeyRequest("sweeper", T0 + API_KEY_RATE_LIMIT_WINDOW_MS + 1);

    // "settled" is gone; "owes" survives because evicting it would silently
    // lose the volume its next row is supposed to report.
    const t2 = T0 + 2 * API_KEY_RATE_LIMIT_WINDOW_MS;
    spend("owes", API_KEY_RATE_LIMIT_MAX, t2);
    const verdict = claimApiKeyRequest("owes", t2);
    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.suppressed).toBe(1);
  });

  it("is generous enough for a busy provisioning client", () => {
    // The plugin's own limiter (10 requests / 24h) is off because it would
    // throttle a legitimate CI pipeline — this replacement must not reintroduce
    // that. A script provisioning one agent a second for a minute must pass.
    for (let i = 0; i < 60; i++) {
      expect(claimApiKeyRequest("ci", T0 + i * 1000)).toEqual({ allowed: true });
    }
  });
});
