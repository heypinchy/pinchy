import type { WebSocket } from "ws";

/**
 * Persistent per-sessionKey subscriber registry for multi-device live-sync
 * (Lane B). Unlike `ActiveRuns.listeners` — which only holds sockets while a run
 * is in flight and a client actively joined it — this map persists for the life
 * of each browser socket, so an idle second device of the same user receives a
 * body-free poke the moment any source changes the session it is viewing.
 *
 * `sessionKey` is `agent:<agentId>:direct:<userId>[:<chatId>]`, always built
 * server-side from the cookie userId. WHICH key a socket may join is decided by
 * the caller behind the same `assertAgentAccess`/`resolveChatId` gate that
 * guards `handleHistory`; this structure only stores the resulting membership.
 *
 * A reverse index (socket → its sessionKeys) makes per-socket teardown
 * O(this socket's keys) instead of an O(all buckets) scan — which matters
 * because the OpenClaw disconnect handler mass-closes every browser socket at
 * once. A closed socket is pruned from every bucket it was in, so it is never a
 * GC root and never receives a stale poke.
 *
 * Node is single-threaded, so every method here is synchronous.
 */
export class SessionSubscribers {
  private buckets = new Map<string, Set<WebSocket>>();
  private reverse = new Map<WebSocket, Set<string>>();

  /**
   * Add a socket to the subscriber set for `sessionKey`. Returns
   * `firstForSession: true` when this is the first socket for the key, so the
   * caller can open the (refcounted) upstream `sessions.messages.subscribe`.
   * Idempotent: re-adding the same socket is a no-op and not a first-join.
   */
  add(sessionKey: string, ws: WebSocket): { firstForSession: boolean } {
    let set = this.buckets.get(sessionKey);
    const firstForSession = !set || set.size === 0;
    if (!set) {
      set = new Set<WebSocket>();
      this.buckets.set(sessionKey, set);
    }
    set.add(ws);

    let keys = this.reverse.get(ws);
    if (!keys) {
      keys = new Set<string>();
      this.reverse.set(ws, keys);
    }
    keys.add(sessionKey);

    return { firstForSession };
  }

  /** The sockets currently subscribed to `sessionKey` (a fresh array). */
  socketsFor(sessionKey: string): WebSocket[] {
    const set = this.buckets.get(sessionKey);
    return set ? [...set] : [];
  }

  /** The sessionKeys a socket is currently subscribed to (a fresh array). */
  sessionKeysFor(ws: WebSocket): string[] {
    const keys = this.reverse.get(ws);
    return keys ? [...keys] : [];
  }

  /**
   * Remove a socket from ONE session (e.g. it switched the open chat). Returns
   * `lastForSession: true` when the bucket is now empty, so the caller can close
   * the refcounted upstream subscription. No-op if the socket/key isn't present.
   */
  removeFromSession(sessionKey: string, ws: WebSocket): { lastForSession: boolean } {
    const set = this.buckets.get(sessionKey);
    if (!set || !set.delete(ws)) return { lastForSession: false };

    const keys = this.reverse.get(ws);
    if (keys) {
      keys.delete(sessionKey);
      if (keys.size === 0) this.reverse.delete(ws);
    }

    if (set.size === 0) {
      this.buckets.delete(sessionKey);
      return { lastForSession: true };
    }
    return { lastForSession: false };
  }

  /**
   * Full teardown for a socket on close AND on error: prune it from every bucket
   * it was in (via the reverse index) and return the sessionKeys whose buckets
   * are now empty, so the caller closes those refcounted upstream subscriptions.
   * Returns `[]` for an unknown socket.
   */
  removeSocket(ws: WebSocket): string[] {
    const keys = this.reverse.get(ws);
    if (!keys) return [];

    const emptied: string[] = [];
    for (const sessionKey of keys) {
      const set = this.buckets.get(sessionKey);
      if (!set) continue;
      set.delete(ws);
      if (set.size === 0) {
        this.buckets.delete(sessionKey);
        emptied.push(sessionKey);
      }
    }
    this.reverse.delete(ws);
    return emptied;
  }
}
