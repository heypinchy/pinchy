import type { IncomingMessage, ServerResponse } from "http";
import { parse } from "url";
import { normalizeHost } from "@/lib/domain-cache";
import { appendAuditLog } from "@/lib/audit";
import { firstHeaderValue, publicHopOf, readRequestHost } from "@/server/forwarded-host";
import { createAuditFloodWindow } from "@/server/audit-flood-window";
import { clientAddressDetail, type ResolvedClientIp } from "@/server/client-ip";

export type CsrfCheckInput = {
  method: string;
  pathname: string | null;
  origin: string | undefined;
  referer: string | undefined;
  host: string | undefined;
  forwardedProto: string | undefined;
};

export type CsrfCheckResult = { allowed: true } | { allowed: false; reason: string };

const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

// Routes exempt from the Origin/Referer check.
// - /api/auth/*       — Better Auth has its own trustedOrigins enforcement.
// - /api/internal/*   — bearer-token-authed (Authorization header) calls from
//                       OpenClaw plugins; not browser-driven, so not CSRF-able.
//                       Browsers cannot forge Authorization headers cross-origin.
//                       That premise is a claim about every route under the
//                       prefix, and it was false once: a session-authed browser
//                       route (POST /api/internal/audit/background-run) sat
//                       there and inherited this exemption, so a cross-site
//                       POST could forge an audit row with the visitor's
//                       session. src/__tests__/security/internal-routes-gateway-auth.test.ts
//                       now fails on any internal route that isn't gateway-token
//                       authed. The domain-lock host check exempts the same
//                       prefix on the same grounds.
const EXEMPT_PREFIXES = ["/api/auth/", "/api/internal/"];

function parseOriginUrl(value: string): { protocol: string; host: string } | null {
  try {
    const url = new URL(value);
    if (!url.protocol || !url.host) return null;
    return { protocol: url.protocol, host: url.host };
  } catch {
    return null;
  }
}

/**
 * Does `candidate` (an `Origin` or `Referer` value) name the same origin the
 * request itself claims?
 *
 * Exported for `ws-upgrade-gate.ts`. The WebSocket upgrade needs the *same*
 * comparison, not a similar one — browsers send `Origin` on the handshake too,
 * and #1056 first shipped a host-only reimplementation here, which accepted an
 * `http://` Origin on an HTTPS instance where this function rejects it. Sharing
 * the function is what makes "equivalent to the CSRF gate" a fact rather than
 * a claim in a comment.
 */
export function matchesRequestHost(
  candidate: string,
  host: string,
  forwardedProto: string | undefined
): boolean {
  const parsed = parseOriginUrl(candidate);
  if (!parsed) return false;
  const expectedProto = `${forwardedProto ?? "http"}:`;
  if (parsed.protocol !== expectedProto) return false;
  return normalizeHost(parsed.host) === normalizeHost(publicHopOf(host));
}

export function isCsrfRequestAllowed(input: CsrfCheckInput): CsrfCheckResult {
  const method = input.method.toUpperCase();
  if (SAFE_METHODS.has(method)) return { allowed: true };

  const pathname = input.pathname ?? "";
  if (!pathname.startsWith("/api/")) return { allowed: true };
  if (EXEMPT_PREFIXES.some((prefix) => pathname.startsWith(prefix))) {
    return { allowed: true };
  }

  if (!input.host) {
    return { allowed: false, reason: "missing-host" };
  }

  if (input.origin !== undefined) {
    if (matchesRequestHost(input.origin, input.host, input.forwardedProto)) {
      return { allowed: true };
    }
    return { allowed: false, reason: "origin-mismatch" };
  }

  if (input.referer !== undefined) {
    if (matchesRequestHost(input.referer, input.host, input.forwardedProto)) {
      return { allowed: true };
    }
    return { allowed: false, reason: "referer-mismatch" };
  }

  return { allowed: false, reason: "missing-origin-and-referer" };
}

/**
 * Origin/Referer-based CSRF gate for state-changing API routes.
 *
 * Returns `true` if the request was blocked (caller should stop processing).
 * Returns `false` if the request is allowed through.
 *
 * Layered with `host-check.ts`: the host check enforces the *destination*
 * matches the locked domain; this gate enforces the *source* matches the
 * destination. Together they prevent the standard cross-site POST attack
 * against authenticated admin sessions (see issue #235).
 */
export async function applyCsrfGate(
  req: IncomingMessage,
  res: ServerResponse,
  client: ResolvedClientIp
): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const { pathname } = parse(req.url ?? "/", false);

  const host = readRequestHost(req.headers);
  const forwardedProto = firstHeaderValue(req.headers["x-forwarded-proto"]);
  const origin = firstHeaderValue(req.headers.origin);
  const referer = firstHeaderValue(req.headers.referer);

  const decision = isCsrfRequestAllowed({
    method,
    pathname,
    origin,
    referer,
    host,
    forwardedProto,
  });

  if (decision.allowed) return false;

  await logCsrfBlocked({
    reason: decision.reason,
    method,
    pathname: pathname ?? "",
    origin,
    referer,
    remoteAddress: req.socket?.remoteAddress,
    client,
  });

  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: "Forbidden: CSRF check failed (Origin/Referer mismatch)",
    })
  );
  return true;
}

/**
 * One `auth.csrf_blocked` row per minute — see `audit-flood-window.ts`.
 *
 * This gate used to be reachable only by a state-changing method, which read
 * as a bound and was the stated reason it carried none. It never was much of
 * one — an anonymous `POST /api/x` with a foreign `Origin` needs no credential
 * either — and #1056 removed even that: the WebSocket upgrade is a `GET`, and
 * `server.ts` runs this same audit for a rejected handshake.
 */
const CSRF_BLOCK_WINDOW_MS = 60_000;
const csrfBlockWindow = createAuditFloodWindow(CSRF_BLOCK_WINDOW_MS);

/** Test seam — the window is process-global, so suites must start from zero. */
export function resetCsrfBlockWindow(): void {
  csrfBlockWindow.reset();
}

export async function logCsrfBlocked(input: {
  reason: string;
  method: string;
  pathname: string;
  origin: string | undefined;
  referer: string | undefined;
  remoteAddress: string | undefined;
  client: ResolvedClientIp;
}): Promise<void> {
  const slot = csrfBlockWindow.claim(Date.now());
  if (!slot.write) return;

  try {
    await appendAuditLog({
      actorType: "system",
      actorId: "system",
      eventType: "auth.csrf_blocked",
      outcome: "failure",
      error: { message: `CSRF blocked: ${input.reason}` },
      detail: {
        method: input.method,
        pathname: input.pathname,
        origin: input.origin ?? null,
        referer: input.referer ?? null,
        remoteAddress: input.remoteAddress ?? null,
        ...clientAddressDetail(input.client),
        ...(slot.suppressed > 0 ? { suppressedSinceLastEntry: slot.suppressed } : {}),
      },
    });
  } catch (err) {
    // Best-effort: a failed audit write must never amplify a CSRF block into
    // a 500 for the legitimate request flow. The 403 still ships.
    console.error("[csrf] failed to append audit log:", err instanceof Error ? err.message : err);
  }
}
