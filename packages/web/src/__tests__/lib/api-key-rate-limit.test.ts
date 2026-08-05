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
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
  claimApiKeyRequest,
  resetApiKeyRateLimits,
  trackedApiKeyCount,
  getApiKeyRateLimitMax,
  DEFAULT_API_KEY_RATE_LIMIT_MAX,
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
    delete process.env.PINCHY_API_KEY_RATE_LIMIT_MAX;
    resetApiKeyRateLimits();
  });

  it("allows the configured budget and rejects the request after it", () => {
    for (let i = 0; i < DEFAULT_API_KEY_RATE_LIMIT_MAX; i++) {
      expect(claimApiKeyRequest("key-1", T0)).toEqual({ allowed: true });
    }

    const verdict = claimApiKeyRequest("key-1", T0);

    expect(verdict.allowed).toBe(false);
  });

  it("budgets each key separately, so one noisy client cannot throttle another", () => {
    spend("noisy", DEFAULT_API_KEY_RATE_LIMIT_MAX, T0);
    expect(claimApiKeyRequest("noisy", T0).allowed).toBe(false);

    // The whole point of keying on the VERIFIED key id: a second key's budget
    // is untouched. A global bucket would deny this one.
    expect(claimApiKeyRequest("quiet", T0)).toEqual({ allowed: true });
  });

  it("reopens the budget once the window has elapsed", () => {
    spend("key-1", DEFAULT_API_KEY_RATE_LIMIT_MAX, T0);
    expect(claimApiKeyRequest("key-1", T0).allowed).toBe(false);

    // One millisecond short of the window is still the same window.
    expect(claimApiKeyRequest("key-1", T0 + API_KEY_RATE_LIMIT_WINDOW_MS - 1).allowed).toBe(false);

    expect(claimApiKeyRequest("key-1", T0 + API_KEY_RATE_LIMIT_WINDOW_MS)).toEqual({
      allowed: true,
    });
  });

  it("reports Retry-After as the time left in the window, rounded up", () => {
    spend("key-1", DEFAULT_API_KEY_RATE_LIMIT_MAX, T0);

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
    spend("key-1", DEFAULT_API_KEY_RATE_LIMIT_MAX, T0);

    const verdict = claimApiKeyRequest("key-1", T0 + API_KEY_RATE_LIMIT_WINDOW_MS - 1);

    if (verdict.allowed) throw new Error("unreachable");
    expect(verdict.retryAfterSeconds).toBeGreaterThanOrEqual(1);
  });

  it("audits the first rejection of a window and suppresses the rest", () => {
    spend("key-1", DEFAULT_API_KEY_RATE_LIMIT_MAX, T0);

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
    spend("key-1", DEFAULT_API_KEY_RATE_LIMIT_MAX, T0);
    claimApiKeyRequest("key-1", T0); // audited, suppressed: 0
    for (let i = 0; i < 7; i++) claimApiKeyRequest("key-1", T0); // suppressed

    // Next window: the budget reopens, is spent again, and the first rejection
    // reports the seven rejections that never got a row of their own. A silent
    // drop would read as "one stray call" when it was eight.
    const t1 = T0 + API_KEY_RATE_LIMIT_WINDOW_MS;
    spend("key-1", DEFAULT_API_KEY_RATE_LIMIT_MAX, t1);

    const next = claimApiKeyRequest("key-1", t1);
    if (next.allowed) throw new Error("unreachable");
    expect(next.audit).toBe(true);
    expect(next.suppressed).toBe(7);
  });

  it("does not re-report a suppressed count that has already been written", () => {
    spend("key-1", DEFAULT_API_KEY_RATE_LIMIT_MAX, T0);
    claimApiKeyRequest("key-1", T0);
    claimApiKeyRequest("key-1", T0); // one suppressed

    const t1 = T0 + API_KEY_RATE_LIMIT_WINDOW_MS;
    spend("key-1", DEFAULT_API_KEY_RATE_LIMIT_MAX, t1);
    const reported = claimApiKeyRequest("key-1", t1);
    if (reported.allowed) throw new Error("unreachable");
    expect(reported.suppressed).toBe(1);

    const t2 = t1 + API_KEY_RATE_LIMIT_WINDOW_MS;
    spend("key-1", DEFAULT_API_KEY_RATE_LIMIT_MAX, t2);
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
    spend("owes", DEFAULT_API_KEY_RATE_LIMIT_MAX, T0);
    claimApiKeyRequest("owes", T0); // audited
    claimApiKeyRequest("owes", T0); // suppressed, not yet reported
    claimApiKeyRequest("settled", T0);

    claimApiKeyRequest("sweeper", T0 + API_KEY_RATE_LIMIT_WINDOW_MS + 1);

    // "settled" is gone; "owes" survives because evicting it would silently
    // lose the volume its next row is supposed to report.
    const t2 = T0 + 2 * API_KEY_RATE_LIMIT_WINDOW_MS;
    spend("owes", DEFAULT_API_KEY_RATE_LIMIT_MAX, t2);
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

/**
 * The operator's knob.
 *
 * 300/min is a guess about somebody else's pipeline. Shipping it as a constant
 * would repeat the mistake this limiter exists to avoid: the plugin's own
 * 10/24h is off precisely because an unconfigurable limit that is wrong for a
 * deployment breaks the trusted automation these keys are for. "Fork the repo
 * and rebuild the image" is not a remedy an operator can carry across
 * upgrades.
 */
describe("getApiKeyRateLimitMax", () => {
  beforeEach(() => {
    delete process.env.PINCHY_API_KEY_RATE_LIMIT_MAX;
    resetApiKeyRateLimits();
  });

  afterEach(() => {
    delete process.env.PINCHY_API_KEY_RATE_LIMIT_MAX;
    resetApiKeyRateLimits();
    vi.restoreAllMocks();
  });

  it("falls back to the shipped default when the operator sets nothing", () => {
    expect(getApiKeyRateLimitMax()).toBe(DEFAULT_API_KEY_RATE_LIMIT_MAX);
  });

  it("honours an override", () => {
    process.env.PINCHY_API_KEY_RATE_LIMIT_MAX = "900";
    resetApiKeyRateLimits();

    expect(getApiKeyRateLimitMax()).toBe(900);
  });

  it("actually widens the budget, not just the reported number", () => {
    // The assertion that matters. A resolver that returns 5 while
    // `claimApiKeyRequest` keeps counting against the constant would satisfy
    // every test above and throttle the operator at 300 anyway.
    process.env.PINCHY_API_KEY_RATE_LIMIT_MAX = "5";
    resetApiKeyRateLimits();

    for (let i = 0; i < 5; i++) {
      expect(claimApiKeyRequest("tuned", T0)).toEqual({ allowed: true });
    }

    expect(claimApiKeyRequest("tuned", T0).allowed).toBe(false);
  });

  it.each([
    ["not-a-number", "abc"],
    ["empty", ""],
    ["zero — an operator locking themselves out by typo", "0"],
    ["negative", "-1"],
    ["fractional", "12.5"],
    ["Infinity", "Infinity"],
  ])("ignores a %s value and keeps the default", (_label, raw) => {
    process.env.PINCHY_API_KEY_RATE_LIMIT_MAX = raw;
    resetApiKeyRateLimits();

    expect(getApiKeyRateLimitMax()).toBe(DEFAULT_API_KEY_RATE_LIMIT_MAX);
  });

  it("says so when it ignores a value, rather than falling back in silence", () => {
    // A silently discarded setting is the worst of both: the operator believes
    // they raised the limit, their pipeline is throttled at 300, and nothing
    // anywhere connects the two. Same principle as the host-check 403 that
    // used to be invisible (AGENTS.md § "/api/internal/ Is A Security Claim").
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.PINCHY_API_KEY_RATE_LIMIT_MAX = "lots";
    resetApiKeyRateLimits();

    getApiKeyRateLimitMax();

    expect(warn).toHaveBeenCalledTimes(1);
    const message = String(warn.mock.calls[0][0]);
    expect(message).toContain("PINCHY_API_KEY_RATE_LIMIT_MAX");
    // Quote the offending value AS WRITTEN: a message built from the converted
    // number says "got NaN", which hides the typo it is reporting.
    expect(message).toContain("lots");
    expect(message).toContain(String(DEFAULT_API_KEY_RATE_LIMIT_MAX));
  });

  it("warns once, not once per request", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    process.env.PINCHY_API_KEY_RATE_LIMIT_MAX = "lots";
    resetApiKeyRateLimits();

    for (let i = 0; i < 50; i++) claimApiKeyRequest("noisy", T0 + i);

    // This runs on the request path. A warning per request would turn a
    // one-character typo into a log flood — the failure mode the audit
    // throttle above exists to prevent, moved to stdout.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("resolves once per process — a change needs a restart, like every other env var", () => {
    process.env.PINCHY_API_KEY_RATE_LIMIT_MAX = "500";
    resetApiKeyRateLimits();
    expect(getApiKeyRateLimitMax()).toBe(500);

    process.env.PINCHY_API_KEY_RATE_LIMIT_MAX = "900";

    // Memoized deliberately: this is read on every API request, and Docker
    // injects env at process start, so re-reading would buy nothing.
    expect(getApiKeyRateLimitMax()).toBe(500);
  });
});
