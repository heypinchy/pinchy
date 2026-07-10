import { WebSocket } from "ws";
import { SessionPokeBridge } from "@/server/session-poke-bridge";
import { SessionSubscribers } from "@/server/session-subscribers";
import { getOpenClawClient } from "@/server/openclaw-client";

/**
 * Process-singleton `SessionPokeBridge` (multi-device live-sync, Lane B).
 *
 * Shared via `globalThis` for the same reason `active-runs-singleton.ts` and
 * `openclaw-client.ts` are: Next.js may load modules in a separate context from
 * the custom server. The upstream per-session subscriptions live on the one
 * shared OpenClawClient, so there must be exactly one bridge per process for the
 * refcount to be correct across every ClientRouter/socket of a session.
 *
 * The real `subscribe` wraps `sessions.subscribeMessages` (which matches the
 * Gateway's canonical key, so canonicalization can't silently drop events); the
 * real `send` JSON-encodes the body-free poke to an OPEN socket only.
 */
const GLOBAL_KEY = "__pinchySessionPokeBridge" as const;

declare global {
  // eslint-disable-next-line no-var
  var __pinchySessionPokeBridge: SessionPokeBridge | undefined;
}

function sendFrame(ws: WebSocket, frame: unknown): void {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(frame));
}

export function getSessionPokeBridgeSingleton(): SessionPokeBridge {
  const existing = (globalThis as Record<string, unknown>)[GLOBAL_KEY] as
    SessionPokeBridge | undefined;
  if (existing) return existing;

  const fresh = new SessionPokeBridge({
    subs: new SessionSubscribers(),
    subscribe: (sessionKey, handler) => {
      const client = getOpenClawClient();
      // No client yet (cold start / OpenClaw down): degrade to "no live sync".
      // handleHistory still serves history, and the client re-pulls on
      // reconnect, so a missed poke window is recoverable.
      if (!client) return Promise.resolve({ unsubscribe: () => {} });
      return client.sessions.subscribeMessages(sessionKey, handler);
    },
    send: sendFrame,
  });

  (globalThis as Record<string, unknown>)[GLOBAL_KEY] = fresh;
  return fresh;
}
