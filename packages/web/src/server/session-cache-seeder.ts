import type { SessionCache } from "./session-cache";

interface OpenClawClientWithSessions {
  sessions: {
    list(): Promise<unknown>;
  };
}

/**
 * Seeds the session cache with all sessions currently known to OpenClaw.
 * Called once when OpenClaw connects so that the retry logic in handleHistory
 * (which checks sessionCache.has()) works correctly on cold start — including
 * after a Pinchy restart when the cache would otherwise be empty.
 *
 * This function is non-critical: failures are silently swallowed and the
 * cache fills naturally as users interact with agents.
 */
export async function seedSessionCache(
  openclawClient: OpenClawClientWithSessions,
  sessionCache: SessionCache
): Promise<void> {
  try {
    const result = (await openclawClient.sessions.list()) as {
      sessions?: { key: string }[];
    };
    sessionCache.refresh(result?.sessions ?? []);
  } catch {
    // Non-critical — cache fills as users interact
  }
}
