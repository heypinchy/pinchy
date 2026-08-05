/**
 * Per-key fixed-window request limiter for `/api/v1/*` (#1086).
 *
 * Better Auth's apiKey plugin ships a per-key limiter and Pinchy turns it off
 * (lib/auth.ts): its default of 10 requests per 24h would throttle a
 * legitimately busy CI pipeline. Better Auth's general-purpose limiter never
 * sees these requests either — it guards the auth router's `onRequest`, and
 * `withApiKey` reaches `verifyApiKey` through `auth.api.*`, which bypasses the
 * router entirely. So an authenticated key was bounded by nothing at all.
 *
 * ## Why the key id, and not the caller's address
 *
 * The bucket is keyed on the **verified** `res.key.id`. That matters twice
 * over:
 *
 *   - It is bounded. An admin has to mint a key before it can occupy an entry,
 *     so the map grows with issued keys rather than with request volume. A map
 *     keyed on anything the caller supplies — a remote address, a header —
 *     grows per request and the throttle stops throttling, which is the same
 *     trap `claimScopeDenialSlot` documents next door in lib/api-auth.ts.
 *   - It is not spoofable. `X-Forwarded-For` is a claim; a verified key id is
 *     a fact Pinchy established one line earlier.
 *
 * The cost of that choice is stated plainly rather than papered over: this
 * bounds what an *authenticated* key can do, and nothing else. A flood of
 * **invalid** keys is answered 401 with no budget involved — `looksLikeApiKey`
 * (lib/api-key-format.ts) at least keeps a wrongly-shaped one from paying for
 * a database lookup, but a well-formed wrong key still does, and nothing
 * bounds how many arrive.
 *
 * That is left to the reverse proxy on purpose rather than left undone: the
 * only handle on an unverified request is its source address, which is a
 * header the caller sets. Keys are 64 random characters, so guessing one is
 * not the threat — load is, and a header-keyed limiter bounds no load while
 * allocating an entry per value an attacker invents. The Agent Provisioning
 * API reference says all of this under its own heading.
 *
 * Per-process state, like `audit-deferred`'s failure counter. Pinchy runs a
 * single Node process per container; a restart just reopens every window,
 * which costs a client at most one extra window's budget.
 */

/**
 * 300 requests per minute per key — 5/s sustained.
 *
 * Picked from the legitimate worst case rather than from a latency budget: a
 * provisioning script creating agents in a loop, or a CI pipeline resetting a
 * staging instance, sits orders of magnitude below this, while a runaway
 * retry loop or a stolen key being drained sits above it. Too low and the
 * limiter breaks exactly the trusted automation these keys exist for — which
 * is why the plugin's own 10/24h is off.
 */
export const API_KEY_RATE_LIMIT_MAX = 300;
export const API_KEY_RATE_LIMIT_WINDOW_MS = 60_000;

/** The window's seconds, for the docs and for `Retry-After` arithmetic. */
export const API_KEY_RATE_LIMIT_WINDOW_SECONDS = API_KEY_RATE_LIMIT_WINDOW_MS / 1000;

export type ApiKeyRateLimitVerdict =
  | { allowed: true }
  | {
      allowed: false;
      /** Seconds until the window reopens. Always ≥ 1. */
      retryAfterSeconds: number;
      /** True for the first rejection in a window — the one that gets a row. */
      audit: boolean;
      /** Rejections since the last audited row, reported on the next one. */
      suppressed: number;
    };

type KeyWindow = {
  openedAt: number;
  count: number;
  /** Rejections that got no row of their own and are still owed a mention. */
  suppressed: number;
  /** Whether this window has already spent its single audit slot. */
  audited: boolean;
};

const windows = new Map<string, KeyWindow>();
let lastSweep = 0;

/** Test seam — windows are process-global, so suites must start from zero. */
export function resetApiKeyRateLimits(): void {
  windows.clear();
  lastSweep = 0;
}

/** Number of keys currently tracked. For tests and observability. */
export function trackedApiKeyCount(): number {
  return windows.size;
}

/**
 * Drop entries whose window is over and which owe nothing.
 *
 * The map is already bounded by issued keys, so this is hygiene rather than a
 * leak fix — a revoked key should not hold an entry until the next restart.
 * Amortized to at most once per window so it stays O(1) per call on average,
 * the same shape `WsRateLimiter.pruneStale` uses.
 *
 * An entry with `suppressed > 0` is kept even when its window has elapsed:
 * evicting it would silently lose the volume its next row is supposed to
 * report, turning "a thousand throttled calls" into "one stray call".
 */
function pruneStale(now: number): void {
  if (now - lastSweep < API_KEY_RATE_LIMIT_WINDOW_MS) return;
  lastSweep = now;
  for (const [keyId, entry] of windows) {
    if (now - entry.openedAt >= API_KEY_RATE_LIMIT_WINDOW_MS && entry.suppressed === 0) {
      windows.delete(keyId);
    }
  }
}

/**
 * Claims one request against `keyId`'s budget.
 *
 * `now` is injected rather than read here so callers (and tests) state window
 * boundaries as arithmetic instead of as sleeps.
 */
export function claimApiKeyRequest(
  keyId: string,
  now: number = Date.now()
): ApiKeyRateLimitVerdict {
  pruneStale(now);

  const open = windows.get(keyId);

  if (!open || now - open.openedAt >= API_KEY_RATE_LIMIT_WINDOW_MS) {
    windows.set(keyId, {
      openedAt: now,
      count: 1,
      // Carried across the boundary: a count earned in the previous window is
      // still owed a row, and the next rejection is where it gets reported.
      suppressed: open?.suppressed ?? 0,
      audited: false,
    });
    return { allowed: true };
  }

  if (open.count < API_KEY_RATE_LIMIT_MAX) {
    open.count++;
    return { allowed: true };
  }

  // Round UP: a client that retries after the rounded-down value arrives
  // inside the same window and is denied again, which reads as the limiter
  // lying about when it reopens.
  const retryAfterSeconds = Math.max(
    1,
    Math.ceil((open.openedAt + API_KEY_RATE_LIMIT_WINDOW_MS - now) / 1000)
  );

  if (!open.audited) {
    open.audited = true;
    const suppressed = open.suppressed;
    open.suppressed = 0;
    return { allowed: false, retryAfterSeconds, audit: true, suppressed };
  }

  open.suppressed++;
  return { allowed: false, retryAfterSeconds, audit: false, suppressed: open.suppressed };
}
