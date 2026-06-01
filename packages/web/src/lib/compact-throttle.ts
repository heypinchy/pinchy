// Per-session-key throttle for manual conversation compaction.
//
// Compaction summarizes a session's in-context transcript — doing it again
// seconds later is wasteful (nothing has changed) and, abused via direct API
// calls, would fan out `sessions.compact` RPCs to OpenClaw. The chat UI already
// debounces (the menu item disables while a request is in flight); this is the
// server-side guard for non-UI callers.
//
// In-memory + per-instance — defense-in-depth, not a distributed guarantee.
// State resets on server restart, which is fine for a throttle.

const lastCompactAt = new Map<string, number>();

/** Minimum gap between compactions of the same session. */
export const COMPACT_MIN_INTERVAL_MS = 10_000;

/**
 * Returns true and records the timestamp if a compaction of `sessionKey` is
 * allowed now; returns false if one was already recorded within
 * `COMPACT_MIN_INTERVAL_MS`. The clock is injectable for deterministic tests.
 */
export function allowCompaction(sessionKey: string, nowMs: number = Date.now()): boolean {
  const last = lastCompactAt.get(sessionKey);
  if (last !== undefined && nowMs - last < COMPACT_MIN_INTERVAL_MS) {
    return false;
  }
  lastCompactAt.set(sessionKey, nowMs);
  return true;
}
