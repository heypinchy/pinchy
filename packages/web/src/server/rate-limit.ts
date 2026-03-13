/**
 * Rate limiter for WebSocket connections and messages.
 *
 * Uses a sliding window approach to track connection attempts per IP
 * and message throughput per authenticated user.
 */

interface RateLimitEntry {
  /** Timestamps of recent events within the window */
  timestamps: number[];
}

interface RateLimiterConfig {
  /** Maximum events allowed within the window */
  maxEvents: number;
  /** Window size in milliseconds */
  windowMs: number;
}

export class RateLimiter {
  private entries = new Map<string, RateLimitEntry>();
  private config: RateLimiterConfig;
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor(config: RateLimiterConfig) {
    this.config = config;
    // Periodic cleanup of stale entries every 60s
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    // Allow GC if server holds no other ref
    if (this.cleanupInterval.unref) this.cleanupInterval.unref();
  }

  /**
   * Check if a key is allowed to proceed.
   * Returns true if within limits, false if rate limited.
   */
  allow(key: string): boolean {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;

    let entry = this.entries.get(key);
    if (!entry) {
      entry = { timestamps: [] };
      this.entries.set(key, entry);
    }

    // Remove timestamps outside the window
    entry.timestamps = entry.timestamps.filter((t) => t > cutoff);

    if (entry.timestamps.length >= this.config.maxEvents) {
      return false;
    }

    entry.timestamps.push(now);
    return true;
  }

  /** Get remaining attempts for a key */
  remaining(key: string): number {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;
    const entry = this.entries.get(key);
    if (!entry) return this.config.maxEvents;

    const active = entry.timestamps.filter((t) => t > cutoff).length;
    return Math.max(0, this.config.maxEvents - active);
  }

  /** Clean up stale entries */
  private cleanup(): void {
    const now = Date.now();
    const cutoff = now - this.config.windowMs;

    for (const [key, entry] of this.entries.entries()) {
      entry.timestamps = entry.timestamps.filter((t) => t > cutoff);
      if (entry.timestamps.length === 0) {
        this.entries.delete(key);
      }
    }
  }

  /** Stop the cleanup interval (for tests / shutdown) */
  destroy(): void {
    clearInterval(this.cleanupInterval);
  }
}

// ─── Default rate limiters ───

/** Rate limit WebSocket upgrade requests: 10 connections per IP per minute */
export const connectionLimiter = new RateLimiter({
  maxEvents: parseInt(process.env.WS_MAX_CONNECTIONS_PER_MIN || "10", 10),
  windowMs: 60_000,
});

/** Rate limit messages per authenticated user: 60 messages per minute */
export const messageLimiter = new RateLimiter({
  maxEvents: parseInt(process.env.WS_MAX_MESSAGES_PER_MIN || "60", 10),
  windowMs: 60_000,
});

/**
 * Extract client IP from request, handling proxies.
 */
export function getClientIp(request: { headers: Record<string, string | string[] | undefined>; socket?: { remoteAddress?: string } }): string {
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded === "string") {
    return forwarded.split(",")[0]!.trim();
  }
  if (Array.isArray(forwarded) && forwarded.length > 0) {
    return forwarded[0]!.split(",")[0]!.trim();
  }
  return request.socket?.remoteAddress || "unknown";
}
