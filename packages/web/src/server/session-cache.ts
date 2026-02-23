const DEFAULT_TTL_MS = 30_000;

interface SessionEntry {
  key: string;
}

export class SessionCache {
  private keys = new Set<string>();
  private lastRefreshed = 0;
  private ttlMs: number;

  constructor(ttlMs = DEFAULT_TTL_MS) {
    this.ttlMs = ttlMs;
  }

  has(key: string): boolean {
    return this.keys.has(key);
  }

  refresh(sessions: SessionEntry[]): void {
    this.keys = new Set(sessions.map((s) => s.key));
    this.lastRefreshed = Date.now();
  }

  add(key: string): void {
    this.keys.add(key);
  }

  isStale(): boolean {
    if (this.lastRefreshed === 0) return true;
    return Date.now() - this.lastRefreshed > this.ttlMs;
  }

  clear(): void {
    this.keys.clear();
    this.lastRefreshed = 0;
  }
}
