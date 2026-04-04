/**
 * In-memory domain cache for synchronous access.
 *
 * This module is deliberately free of Node.js-only imports (crypto, fs, etc.)
 * so it can be used from Next.js Edge Middleware without triggering warnings.
 *
 * Write-side functions (loadDomainCache, set/delete) live in domain.ts
 * and call setCachedDomain/clearCachedDomain to update the cache.
 */

let cachedDomain: string | null | undefined = undefined; // undefined = not loaded yet

/**
 * Synchronous read of the cached domain.
 * Returns null if the cache hasn't been loaded yet (safe default = insecure mode).
 */
export function getCachedDomain(): string | null {
  return cachedDomain ?? null;
}

/** Update the cached domain value. Called by domain.ts after DB writes. */
export function setCachedDomain(domain: string | null): void {
  cachedDomain = domain;
}

/** Strip default ports (:80, :443) from a host string for comparison. */
export function normalizeHost(host: string): string {
  return host.replace(/:(80|443)$/, "");
}

/** Reset cache to unloaded state — only for tests. */
export function _resetCacheForTests(): void {
  cachedDomain = undefined;
}
