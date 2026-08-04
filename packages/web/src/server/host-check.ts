import type { IncomingMessage, ServerResponse } from "http";
import { parse } from "url";
import { getCachedDomain, normalizeHost } from "@/lib/domain-cache";
import { appendAuditLog, safeAuditPath } from "@/lib/audit";
import { publicHopOf, readRequestHost } from "@/server/forwarded-host";

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

  // Both sides folded to their public hop. The request side matters because a
  // proxy chain arrives as "public.example.com, internal:7777"; the stored side
  // matters because an instance locked by an older version has that whole chain
  // saved as its domain, and nothing rewrites the row on upgrade. Folding only
  // one side would lock those installs out.
  return normalizeHost(publicHopOf(host)) === normalizeHost(publicHopOf(lockedDomain));
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

// `domain` is read from `getCachedDomain()`, ultimately client-influenced
// (the value POST /api/settings/domain stores is the request's own resolved
// Host). `POST /api/settings/domain` now rejects anything that isn't a valid
// domain name before it is persisted, but a row written before that guard
// existed — or edited directly in the database — must not turn into stored
// markup on a page served to every unauthenticated visitor with a mismatched
// Host header. Escape it here too, independent of the write-side guard.
const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

function accessDeniedPage(domain: string | null): string {
  const safeDomain = domain ? escapeHtml(domain) : null;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Access Denied — Pinchy</title>
<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0a0a0a;color:#e5e5e5}
.card{max-width:420px;padding:2rem;text-align:center}.icon{font-size:2rem;margin-bottom:1rem}h1{font-size:1.25rem;margin:0 0 .75rem}
p{color:#a3a3a3;font-size:.875rem;line-height:1.5;margin:0 0 1rem}a{color:#f59e0b;text-decoration:none}a:hover{text-decoration:underline}</style></head>
<body><div class="card"><div class="icon">🔒</div><h1>Access Denied</h1>
<p>This Pinchy instance is locked to a specific domain. You're accessing it from an address that isn't allowed.</p>
${safeDomain ? `<p><a href="https://${safeDomain}">Go to ${safeDomain} →</a></p>` : ""}
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
  const host = readRequestHost(req.headers);

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
 * One `auth.host_blocked` row per minute, with the rejections it stood in for
 * counted on the next row rather than dropped.
 *
 * Recording a block is worth doing; recording every block is bounded by
 * nothing. This is the one audit event an *unauthenticated* caller can trigger
 * at will — a domain-locked instance is by definition reachable at an address
 * that isn't its domain, and `GET http://<raw-ip>/api/x` in a loop needs no
 * credential, no cookie and no state-changing method. Every row takes
 * `pg_advisory_xact_lock` on a single constant key (lib/audit.ts), so an
 * unbounded stream doesn't just grow an immutable table: it serializes every
 * genuine audit write in the process behind itself. And it buries exactly what
 * the event exists to surface — one of Pinchy's own components being turned
 * away.
 *
 * The window is global, not keyed. Every dimension available to key on — host,
 * path, remote address — is supplied by the caller, so a map keyed on one of
 * them grows per request and the throttle stops throttling. (`scopeDenialWindows`
 * in lib/api-auth.ts can key by API key precisely because an admin must mint
 * one first.) The cost is real and accepted: within a minute, a flood can mask
 * a different component's block. The row that does get written still names its
 * own host and path, and `suppressedSinceLastEntry` reports the scale.
 *
 * Per-process state; a restart just reopens the window, which costs one row.
 */
const HOST_BLOCK_WINDOW_MS = 60_000;
let hostBlockWindow: { openedAt: number; suppressed: number } | null = null;

/** Test seam — the window is process-global, so suites must start from zero. */
export function resetHostBlockWindow(): void {
  hostBlockWindow = null;
}

function claimHostBlockSlot(now: number): { write: boolean; suppressed: number } {
  if (hostBlockWindow && now - hostBlockWindow.openedAt < HOST_BLOCK_WINDOW_MS) {
    hostBlockWindow.suppressed++;
    return { write: false, suppressed: hostBlockWindow.suppressed };
  }
  const suppressed = hostBlockWindow?.suppressed ?? 0;
  hostBlockWindow = { openedAt: now, suppressed: 0 };
  return { write: true, suppressed };
}

/**
 * Record a domain-lock rejection in the audit trail.
 *
 * The signal this exists to provide (#599): a rejected API call left no trace
 * on the Pinchy side at all. The only evidence that pinchy-transcript's capture
 * POST was being turned away sat in the OpenClaw container's stdout, so a
 * shipped feature was dead in production for eleven weeks with every check
 * green. Mirrors `logCsrfBlocked` — same actor, same best-effort contract —
 * plus the window above, which the CSRF gate does not need as urgently: it
 * blocks only state-changing methods, so it cannot be driven by a plain GET.
 */
export async function logHostBlocked(input: {
  method: string;
  pathname: string;
  host: string | undefined;
  lockedDomain: string | null;
  remoteAddress: string | undefined;
}): Promise<void> {
  const slot = claimHostBlockSlot(Date.now());
  if (!slot.write) return;

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
        ...(slot.suppressed > 0 ? { suppressedSinceLastEntry: slot.suppressed } : {}),
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
