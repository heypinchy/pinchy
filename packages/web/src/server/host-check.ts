import type { IncomingMessage, ServerResponse } from "http";
import { parse } from "url";
import { getCachedDomain, normalizeHost } from "@/lib/domain-cache";
import { appendAuditLog, safeAuditPath } from "@/lib/audit";

// Paths that bypass the domain-lock host check. Health/status endpoints must
// remain accessible for monitoring/setup.
const EXEMPT_PATHS = ["/api/health", "/api/setup/status", "/api/version"];

// Gateway-token-protected internal plugin endpoints are called from the
// OpenClaw container over a Docker-internal hostname (`pinchy:7777`), which by
// definition never matches the locked public domain — so the whole
// `/api/internal/` prefix bypasses host matching.
//
// This used to be a hand-written list of individual paths, and it drifted:
// `/api/internal/channel-messages` was never added to it, so with a domain lock
// configured, every capture POST from pinchy-transcript was answered with 403
// and Pinchy's owned transcript stayed empty in production for eleven weeks
// (#599). `knowledge/search` and `report-auth-failure` were missing too.
//
// The prefix is therefore a security claim — everything under it is bearer-token
// plugin traffic, never a browser — and
// `src/__tests__/security/internal-routes-gateway-auth.test.ts` is what keeps it
// true. The CSRF gate (src/server/csrf-check.ts) exempts the same prefix on the
// same grounds.
const INTERNAL_PLUGIN_PREFIX = "/api/internal/";

// The one internal route with no gateway token: OpenClaw's readiness probe,
// read by the container's own healthcheck. Unauthenticated, so it is exempt
// only for same-container loopback callers.
export const LOOPBACK_ONLY_EXEMPT_PATHS = ["/api/internal/openclaw-config-ready"];

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalizedHost = normalizeHost(host);
  if (normalizedHost === "::1" || normalizedHost.startsWith("[::1]")) return true;
  const hostname = normalizedHost.replace(/:\d+$/, "");
  return hostname === "localhost" || hostname === "127.0.0.1";
}

/**
 * Check if a request should be blocked based on the locked domain.
 * Returns true if the request is allowed, false if it should be rejected with 403.
 */
export function isHostAllowed(host: string | undefined, pathname: string | null): boolean {
  const lockedDomain = getCachedDomain();
  if (!lockedDomain) return true;

  if (pathname) {
    if (EXEMPT_PATHS.some((p) => pathname === p)) return true;
    if (LOOPBACK_ONLY_EXEMPT_PATHS.some((p) => pathname === p)) {
      // Falls through to host matching when the caller isn't loopback, so a
      // request that arrives on the locked domain is still served.
      if (isLoopbackHost(host)) return true;
    } else if (pathname.startsWith(INTERNAL_PLUGIN_PREFIX)) {
      return true;
    }
  }

  if (!host) return false;

  return normalizeHost(host) === normalizeHost(lockedDomain);
}

/**
 * Should a rejected request be recorded in the audit log?
 *
 * API paths only. A locked instance answers every scanner that finds its raw
 * IP, and those hit pages — auditing them would bury the rows that matter
 * (a plugin, an integration, an operator's own tooling being turned away)
 * under crawler noise. A rejected page request already surfaces to the human
 * in front of it as the "Access Denied" screen.
 */
export function shouldAuditHostBlock(pathname: string | null): boolean {
  return !!pathname && pathname.startsWith("/api/");
}

function accessDeniedPage(domain: string | null): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access Denied — Pinchy</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.card{max-width:420px;padding:2rem;text-align:center}.icon{font-size:2rem;margin-bottom:1rem}h1{font-size:1.25rem;margin:0 0 .75rem}
p{color:#a3a3a3;font-size:.875rem;line-height:1.5;margin:0 0 1rem}a{color:#f59e0b;text-decoration:none}a:hover{text-decoration:underline}</style></head>
<body><div class="card"><div class="icon">🔒</div><h1>Access Denied</h1>
<p>This Pinchy instance is locked to a specific domain. You're accessing it from an address that isn't allowed.</p>
${domain ? `<p><a href="https://${domain}">Go to ${domain} →</a></p>` : ""}
</div></body></html>`;
}

/**
 * Domain-lock gate: reject requests whose Host doesn't match the locked domain.
 *
 * Returns `true` if the request was blocked (caller should stop processing),
 * `false` if it is allowed through — same contract as `applyCsrfGate`, which
 * runs right after it. Both live in a function rather than inline in server.ts
 * so the gate's behaviour, including its audit trail, is testable without
 * booting the app.
 */
export async function applyDomainLockGate(
  req: IncomingMessage,
  res: ServerResponse
): Promise<boolean> {
  const { pathname } = parse(req.url ?? "/", false);
  const forwardedHost = req.headers["x-forwarded-host"];
  const host =
    (Array.isArray(forwardedHost) ? forwardedHost[0] : forwardedHost) || req.headers.host;

  if (isHostAllowed(host, pathname)) return false;

  if (shouldAuditHostBlock(pathname)) {
    // Not awaited: the 403 must not wait on a DB write, and logHostBlocked
    // swallows its own failures (same contract as the CSRF gate's audit).
    void logHostBlocked({
      method: (req.method ?? "GET").toUpperCase(),
      pathname: pathname ?? "",
      host,
      lockedDomain: getCachedDomain(),
      remoteAddress: req.socket?.remoteAddress,
    });
  }

  if ((req.headers.accept || "").includes("text/html")) {
    res.writeHead(403, { "Content-Type": "text/html; charset=utf-8" });
    res.end(accessDeniedPage(getCachedDomain()));
  } else {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({ error: "Forbidden: request host does not match the configured domain" })
    );
  }
  return true;
}

/**
 * Record a domain-lock rejection in the audit trail.
 *
 * The signal this exists to provide (#599): a rejected API call left no trace
 * on the Pinchy side at all. The only evidence that pinchy-transcript's capture
 * POST was being turned away sat in the OpenClaw container's stdout, so a
 * shipped feature was dead in production for eleven weeks with every check
 * green. Mirrors `logCsrfBlocked` — same actor, same best-effort contract.
 */
export async function logHostBlocked(input: {
  method: string;
  pathname: string;
  host: string | undefined;
  lockedDomain: string | null;
  remoteAddress: string | undefined;
}): Promise<void> {
  try {
    await appendAuditLog({
      actorType: "system",
      actorId: "system",
      eventType: "auth.host_blocked",
      outcome: "failure",
      error: {
        message: `Host blocked: ${input.host ?? "<missing host header>"} does not match the locked domain`,
      },
      detail: {
        method: input.method,
        // Both are sized by whoever sent the request; capped so one long field
        // can't push the detail past MAX_DETAIL_BYTES and cost the row every
        // other key (see safeAuditPath).
        pathname: safeAuditPath(input.pathname),
        host: input.host ? safeAuditPath(input.host) : null,
        lockedDomain: input.lockedDomain,
        remoteAddress: input.remoteAddress ?? null,
      },
    });
  } catch (err) {
    // Best-effort: a failed audit write must never turn a 403 into a 500.
    console.error(
      "[host-check] failed to append audit log:",
      err instanceof Error ? err.message : err
    );
  }
}
