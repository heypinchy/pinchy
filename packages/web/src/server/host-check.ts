import { getCachedDomain, normalizeHost } from "@/lib/domain-cache";

// Paths that bypass the domain-lock host check. Health/status endpoints must
// remain accessible for monitoring/setup. Gateway-token-protected internal
// plugin endpoints are called through Docker-internal hostnames, so they also
// bypass host matching. The unauthenticated OpenClaw readiness endpoint is
// only exempt for same-container loopback healthchecks.
const EXEMPT_PATHS = ["/api/health", "/api/setup/status"];
const LOOPBACK_ONLY_EXEMPT_PATHS = ["/api/internal/openclaw-config-ready"];

function isLoopbackHost(host: string | undefined): boolean {
  if (!host) return false;
  const normalizedHost = normalizeHost(host);
  if (normalizedHost === "::1" || normalizedHost.startsWith("[::1]")) return true;
  const hostname = normalizedHost.replace(/:\d+$/, "");
  return hostname === "localhost" || hostname === "127.0.0.1";
}

function isGatewayTokenProtectedInternalPath(pathname: string): boolean {
  if (
    pathname === "/api/internal/audit/tool-use" ||
    pathname === "/api/internal/settings/context" ||
    pathname === "/api/internal/usage/record"
  ) {
    return true;
  }

  if (pathname.startsWith("/api/internal/users/") && pathname.endsWith("/context")) {
    return true;
  }

  return pathname.startsWith("/api/internal/integrations/") && pathname.endsWith("/credentials");
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
    if (isGatewayTokenProtectedInternalPath(pathname)) return true;
    if (LOOPBACK_ONLY_EXEMPT_PATHS.some((p) => pathname === p) && isLoopbackHost(host)) {
      return true;
    }
  }

  if (!host) return false;

  return normalizeHost(host) === normalizeHost(lockedDomain);
}
