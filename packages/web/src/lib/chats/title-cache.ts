/**
 * Module-private, process-local cache of derived chat titles, keyed by
 * sessionId, used by GET /api/agents/[agentId]/chats.
 *
 * Lives outside the route file on purpose: Next.js App Router route modules
 * may only export HTTP method handlers and well-known config symbols (same
 * reason `usage-record-rate-limiter.ts` keeps its limiter out of its route
 * file). Keeping the cache here also lets tests drive eviction
 * deterministically instead of poking at a module-private Map through the
 * route's exported GET handler alone.
 *
 * Bounded two ways:
 *  - TTL: a chat's first user message never changes, so a short TTL just
 *    spares re-reading the same transcript on rapid re-opens (dropdown
 *    re-fetches on every open).
 *  - Max entry count: the TTL above is only checked on READ, never evicted
 *    on its own, so without a cap this Map grew by one entry per distinct
 *    sessionId ever looked up, for the lifetime of the process — a slow,
 *    unbounded memory leak. Eviction is FIFO by insertion order: `Map`
 *    preserves insertion order, and re-`set`-ting an EXISTING key does not
 *    move it, so the oldest entry is always `titleCache.keys().next().value`.
 *    That is good enough here — this is a size safety valve, not an LRU cache
 *    tuned for hit rate, so a real LRU library would solve a problem this
 *    cache doesn't have.
 */

const TITLE_CACHE_TTL_MS = 60_000;
const TITLE_CACHE_MAX_ENTRIES = 500;

interface TitleCacheEntry {
  title: string | null;
  at: number;
}

const titleCache = new Map<string, TitleCacheEntry>();

/**
 * Returns the cached title, or `undefined` if there is no entry or it's past
 * its TTL (the caller re-derives the title in that case).
 */
export function getCachedChatTitle(sessionId: string): string | null | undefined {
  const cached = titleCache.get(sessionId);
  if (!cached || Date.now() - cached.at >= TITLE_CACHE_TTL_MS) return undefined;
  return cached.title;
}

/** Caches a derived title, evicting the oldest entry once over the cap. */
export function setCachedChatTitle(sessionId: string, title: string | null): void {
  titleCache.set(sessionId, { title, at: Date.now() });
  if (titleCache.size > TITLE_CACHE_MAX_ENTRIES) {
    const oldestKey = titleCache.keys().next().value;
    if (oldestKey !== undefined) titleCache.delete(oldestKey);
  }
}

/** Test-only: current entry count, to assert the eviction cap holds. */
export function getTitleCacheSizeForTest(): number {
  return titleCache.size;
}

/** Test-only: clears the cache so tests don't leak state into each other. */
export function resetTitleCacheForTest(): void {
  titleCache.clear();
}
