// HTTP keep-alive tuning for Pinchy's custom Node server (server.ts).
//
// Node's `http.Server` defaults `keepAliveTimeout` to 5s: it closes an idle
// keep-alive connection 5s after the last response. A client that pools and
// REUSES connections — the browser, and Playwright's APIRequestContext in our
// E2E suite, but also a production reverse proxy (Caddy/nginx/Traefik) — can
// pick a socket the server is closing at that exact moment and observe
// ECONNRESET, surfaced as `socket hang up`. It's a race, so it's intermittent
// (it flaked one unrelated E2E request, green on every prior run), but the
// window is real whenever the server sets no timeout.
//
// Fix: hold idle connections far longer than any realistic inter-request gap
// (test step, or proxy keep-alive). Node additionally requires
// `headersTimeout > keepAliveTimeout` — otherwise `headersTimeout` can fire
// while the server idly waits for the next request on a kept-alive socket and
// re-introduces the reset. Both live here, applied together, so the invariant
// can't drift.

import type { Server } from "http";

/**
 * Idle keep-alive window. 65s clears Node's 5s default by a wide margin and
 * sits just above the common 60s reverse-proxy idle timeout, so the proxy (or
 * test client) never reuses a socket Pinchy is simultaneously closing.
 */
export const KEEP_ALIVE_TIMEOUT_MS = 65_000;

/**
 * Must exceed {@link KEEP_ALIVE_TIMEOUT_MS} (Node requirement). 1s of headroom
 * is enough — its only job is to stay strictly greater.
 */
export const HEADERS_TIMEOUT_MS = 66_000;

/** Apply the keep-alive tuning to a server instance. Idempotent. */
export function applyKeepAliveTuning(server: Server): void {
  server.keepAliveTimeout = KEEP_ALIVE_TIMEOUT_MS;
  server.headersTimeout = HEADERS_TIMEOUT_MS;
}
