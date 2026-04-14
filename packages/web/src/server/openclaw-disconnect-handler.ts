import type { WebSocket } from "ws";
import type { OpenClawClient } from "openclaw-node";

const WS_OPEN = 1;

/**
 * Closes all active browser WebSockets when OpenClaw first disconnects, then
 * waits for OpenClaw to reconnect before arming the handler again.
 *
 * WHY ONCE-PER-PERIOD:
 * openclaw-node emits "disconnected" on every failed reconnect attempt
 * (~1 second interval with default config). If we closed browser WebSockets on
 * every event, the browser could never re-establish a stable connection while
 * Pinchy is waiting for OpenClaw to come back — the new browser WS would be torn
 * down almost immediately.
 *
 * WHY CLOSE AT ALL:
 * openclaw-node's chat() generator hangs indefinitely when the underlying
 * OpenClaw WebSocket closes: its internal resolveChunk promise is never resolved.
 * The server-side for-await loop blocks forever, heartbeats keep firing, and the
 * browser's stuck timer never triggers. Closing the browser WebSocket fires the
 * browser's existing onclose handler which injects the disconnect error (if a
 * stream was in progress) and triggers auto-reconnect.
 */
export function setupOpenClawDisconnectHandler(
  openclawClient: Pick<OpenClawClient, "on">,
  sessionMap: Map<WebSocket, unknown>
): void {
  let closedForCurrentDisconnect = false;

  openclawClient.on("connected", () => {
    // OpenClaw is back — re-arm the handler so the next disconnect is caught.
    closedForCurrentDisconnect = false;
  });

  openclawClient.on("disconnected", () => {
    if (closedForCurrentDisconnect) return;
    closedForCurrentDisconnect = true;

    for (const [clientWs] of sessionMap) {
      if (clientWs.readyState === WS_OPEN) {
        clientWs.close(1001, "OpenClaw disconnected");
      }
    }
  });
}
