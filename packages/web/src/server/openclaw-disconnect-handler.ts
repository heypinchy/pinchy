import type { WebSocket } from "ws";
import type { OpenClawClient } from "openclaw-node";

const WS_OPEN = 1;

/**
 * Closes all active browser WebSockets when OpenClaw disconnects.
 *
 * openclaw-node's chat() generator hangs indefinitely when the underlying
 * WebSocket closes (its internal resolveChunk promise is never resolved).
 * Closing the browser WebSocket triggers the browser's disconnect-recovery
 * path, which injects an error message (if a stream was in progress) and
 * auto-reconnects — without waiting for the zombie server-side generator.
 */
export function setupOpenClawDisconnectHandler(
  openclawClient: Pick<OpenClawClient, "on">,
  sessionMap: Map<WebSocket, unknown>
): void {
  openclawClient.on("disconnected", () => {
    for (const [clientWs] of sessionMap) {
      if (clientWs.readyState === WS_OPEN) {
        clientWs.close(1001, "OpenClaw disconnected");
      }
    }
  });
}
