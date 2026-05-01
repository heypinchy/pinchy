import type { IncomingMessage, ServerResponse } from "http";
import { parse } from "url";
import { normalizeHost } from "@/lib/domain-cache";
import { appendAuditLog } from "@/lib/audit";

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

// Better Auth maintains its own trustedOrigins check on /api/auth/* routes
// (see packages/web/src/lib/auth.ts trustedOrigins option). We exempt that
// prefix to avoid double-enforcement and to keep its config the single source
// of truth for sign-in/sign-out.
const EXEMPT_PREFIXES = ["/api/auth/"];

function parseOriginUrl(value: string): { protocol: string; host: string } | null {
  try {
    const url = new URL(value);
    if (!url.protocol || !url.host) return null;
    return { protocol: url.protocol.replace(/:$/, ""), host: url.host };
  } catch {
    return null;
  }
}

function matchesRequestHost(
  candidate: string,
  host: string,
  forwardedProto: string | undefined
): boolean {
  const parsed = parseOriginUrl(candidate);
  if (!parsed) return false;
  const expectedProto = forwardedProto ?? "http";
  if (parsed.protocol !== expectedProto) return false;
  return normalizeHost(parsed.host) === normalizeHost(host);
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

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
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
export async function applyCsrfGate(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const method = (req.method ?? "GET").toUpperCase();
  const { pathname } = parse(req.url ?? "/", false);

  const host =
    firstHeaderValue(req.headers["x-forwarded-host"]) ?? firstHeaderValue(req.headers.host);
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
  });

  res.writeHead(403, { "Content-Type": "application/json" });
  res.end(
    JSON.stringify({
      error: "Forbidden: CSRF check failed (Origin/Referer mismatch)",
    })
  );
  return true;
}

export async function logCsrfBlocked(input: {
  reason: string;
  method: string;
  pathname: string;
  origin: string | undefined;
  referer: string | undefined;
  remoteAddress: string | undefined;
}): Promise<void> {
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
      },
    });
  } catch (err) {
    // Best-effort: a failed audit write must never amplify a CSRF block into
    // a 500 for the legitimate request flow. The 403 still ships.
    console.error("[csrf] failed to append audit log:", err instanceof Error ? err.message : err);
  }
}
