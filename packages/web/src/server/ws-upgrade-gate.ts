import type { IncomingMessage } from "http";
import { normalizeHost } from "@/lib/domain-cache";
import { firstHeaderValue, publicHopOf, readRequestHost } from "@/server/forwarded-host";
import { isHostAllowed } from "@/server/host-check";
import { parseOriginUrl } from "@/server/csrf-check";

/**
 * The two checks `server.ts`'s `server.on("upgrade", ...)` handler runs
 * before session-cookie auth (`validateWsSession`) for `/api/ws`.
 *
 * The upgrade path is a second, separate request-handling entry point from
 * the one `applyDomainLockGate`/`applyCsrfGate` are installed on
 * (`createServer(async (req, res) => ...)`), so those two gates never see a
 * WebSocket upgrade at all. Two consequences, mirrored one check each below:
 *
 * - A domain-locked instance still accepts upgrades addressed to the raw IP
 *   or any other host — the domain lock's whole guarantee, skipped.
 * - WebSocket handshakes are not subject to CORS/SOP the way `fetch` is, so
 *   there is no browser-level defense against cross-site WebSocket hijacking.
 *   The only thing standing in the way is the session cookie's `SameSite`
 *   attribute (see `src/lib/auth.ts`), which is a browser default, not an
 *   application-level check.
 */
export type WsUpgradeCheckInput = {
  pathname: string | null;
  host: string | undefined;
  origin: string | undefined;
};

export type WsUpgradeCheckResult =
  | { allowed: true }
  | { allowed: false; reason: "domain-lock" }
  | { allowed: false; reason: "origin-mismatch" };

/**
 * Decide whether a `/api/ws` upgrade request may proceed to session-cookie
 * auth. Pure function, no I/O — same shape as `isHostAllowed` /
 * `isCsrfRequestAllowed`, so it is testable without a real socket.
 *
 * Order matters: domain lock (destination) is checked before Origin (source),
 * matching `server.ts`'s "destination first, then source" ordering for the
 * HTTP gates.
 *
 * - Domain lock: identical to `applyDomainLockGate`'s host check
 *   (`isHostAllowed`), reused rather than duplicated. Docker-internal callers
 *   and every E2E stack (no domain configured, `getCachedDomain()` is null)
 *   behave exactly as they do on the HTTP gate — inert.
 * - Origin: when an `Origin` header is present, its host must equal the
 *   request's own host (read the same proxy-aware way as the HTTP gates, via
 *   `readRequestHost`/`publicHopOf`). No `Origin` header (a non-browser
 *   caller — an internal tool, a script) is let through unchecked; the
 *   session cookie remains the actual authorization gate for those.
 */
export function isWsUpgradeAllowed(input: WsUpgradeCheckInput): WsUpgradeCheckResult {
  if (!isHostAllowed(input.host, input.pathname)) {
    return { allowed: false, reason: "domain-lock" };
  }

  if (input.origin !== undefined) {
    if (!input.host) {
      return { allowed: false, reason: "origin-mismatch" };
    }
    const parsedOrigin = parseOriginUrl(input.origin);
    if (
      !parsedOrigin ||
      normalizeHost(parsedOrigin.host) !== normalizeHost(publicHopOf(input.host))
    ) {
      return { allowed: false, reason: "origin-mismatch" };
    }
  }

  return { allowed: true };
}

/** Reads the headers `isWsUpgradeAllowed` needs off the raw upgrade request. */
export function readWsUpgradeCheckInput(
  request: IncomingMessage,
  pathname: string | null
): WsUpgradeCheckInput {
  return {
    pathname,
    host: readRequestHost(request.headers),
    origin: firstHeaderValue(request.headers.origin),
  };
}
