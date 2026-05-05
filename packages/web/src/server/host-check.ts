import { getCachedDomain, normalizeHost } from "@/lib/domain-cache";

// Paths that bypass the domain-lock host check.
// Health/status endpoints and internal service callbacks must remain reachable
// from the Docker network even when the public host is locked.
const EXEMPT_PATHS = ["/api/health", "/api/setup/status"];
const EXEMPT_PREFIXES = ["/api/internal/"];

/**
 * Check if a request should be blocked based on the locked domain.
 * Returns true if the request is allowed, false if it should be rejected with 403.
 */
export function isHostAllowed(host: string | undefined, pathname: string | null): boolean {
  const lockedDomain = getCachedDomain();
  if (!lockedDomain) return true;

  if (pathname && EXEMPT_PATHS.some((p) => pathname === p)) return true;
  if (pathname && EXEMPT_PREFIXES.some((p) => pathname.startsWith(p))) return true;

  if (!host) return false;

  return normalizeHost(host) === normalizeHost(lockedDomain);
}
