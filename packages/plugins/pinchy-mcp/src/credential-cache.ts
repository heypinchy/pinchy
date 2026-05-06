/**
 * Per-connection credential cache with 5-minute TTL.
 *
 * On cache miss (or after TTL expiry) the provided fetcher is called once
 * and the result is stored. On 401 from the MCP server the caller should
 * call `invalidate()` before the next retry so the fetcher runs again.
 */
export class CredentialCache {
  private cache: Map<string, { token: string; expiresAt: number }> = new Map();

  private static readonly TTL_MS = 5 * 60 * 1000; // 5 minutes

  async get(connectionId: string, fetcher: () => Promise<string>): Promise<string> {
    const entry = this.cache.get(connectionId);
    if (entry && entry.expiresAt > Date.now()) return entry.token;
    const token = await fetcher();
    this.cache.set(connectionId, { token, expiresAt: Date.now() + CredentialCache.TTL_MS });
    return token;
  }

  invalidate(connectionId: string): void {
    this.cache.delete(connectionId);
  }
}
