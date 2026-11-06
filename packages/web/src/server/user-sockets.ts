import type { WebSocket } from "ws";
import {
  ACCOUNT_DEACTIVATED_CLOSE_CODE,
  ACCOUNT_DEACTIVATED_ERROR_CODE,
} from "@/lib/account-deactivated";

export { ACCOUNT_DEACTIVATED_CLOSE_CODE };

/**
 * Open browser sockets per user, so deactivating an account reaches the chats
 * it already has open.
 *
 * server.ts authenticates a WebSocket once, at the upgrade, and the connection
 * then lives for as long as the tab does. DELETE /api/users/:id bans the
 * account and deletes its session rows, which refuses the NEXT upgrade — but
 * on its own it leaves every open chat working, agent tools included. The
 * route therefore calls `revoke()` here, which closes those sockets, and
 * ClientRouter refuses any message from a revoked user that is still in
 * flight on a closing socket.
 *
 * The revoked set is process memory, and that is enough: a restart drops every
 * socket anyway, and a new one has to pass the upgrade, whose session lookup
 * the deactivation already emptied. Reactivation (`restore()`) clears it.
 */

const CLOSE_REASON = "Account deactivated";
const ERROR_FRAME = JSON.stringify({
  type: "error",
  code: ACCOUNT_DEACTIVATED_ERROR_CODE,
  message: "Your account has been deactivated.",
});

const WS_OPEN = 1;

export class UserSocketRegistry {
  private readonly sockets = new Map<string, Set<WebSocket>>();
  private readonly revoked = new Set<string>();

  /**
   * Track an open socket until it closes. A socket for a user revoked in the
   * meantime — the upgrade checked the session a moment before the
   * deactivation committed — is closed at once instead.
   */
  register(userId: string, ws: WebSocket): void {
    if (this.revoked.has(userId)) {
      refuseDeactivatedSocket(ws);
      return;
    }
    let set = this.sockets.get(userId);
    if (!set) {
      set = new Set();
      this.sockets.set(userId, set);
    }
    set.add(ws);
    ws.once("close", () => this.forget(userId, ws));
  }

  isRevoked(userId: string): boolean {
    return this.revoked.has(userId);
  }

  /** Deactivation: close every open socket of the user and refuse new ones. */
  revoke(userId: string): number {
    this.revoked.add(userId);
    const set = this.sockets.get(userId);
    this.sockets.delete(userId);
    if (!set) return 0;
    for (const ws of set) refuseDeactivatedSocket(ws);
    return set.size;
  }

  /** Reactivation. */
  restore(userId: string): void {
    this.revoked.delete(userId);
  }

  openSocketCount(userId: string): number {
    return this.sockets.get(userId)?.size ?? 0;
  }

  private forget(userId: string, ws: WebSocket): void {
    const set = this.sockets.get(userId);
    if (!set) return;
    set.delete(ws);
    if (set.size === 0) this.sockets.delete(userId);
  }
}

/** Tell the tab why, then close. Used for both open and freshly-upgraded sockets. */
export function refuseDeactivatedSocket(ws: WebSocket): void {
  if (ws.readyState === WS_OPEN) {
    ws.send(ERROR_FRAME);
    ws.close(ACCOUNT_DEACTIVATED_CLOSE_CODE, CLOSE_REASON);
  }
}

// Shared via globalThis, like active-runs-singleton.ts: Next.js may load API
// routes in a separate module context from the custom server, and the route
// that deactivates must see the sockets server.ts registered.
const GLOBAL_KEY = "__pinchyUserSocketRegistry" as const;

declare global {
  var __pinchyUserSocketRegistry: UserSocketRegistry | undefined;
}

export function getUserSocketRegistry(): UserSocketRegistry {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
    UserSocketRegistry | undefined;
  if (existing) return existing;
  const fresh = new UserSocketRegistry();
  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = fresh;
  return fresh;
}
