import type { WebSocket } from "ws";
import type { OpenClawClient } from "openclaw-node";

const WS_OPEN = 1;

/**
 * Broadcasts upstream OpenClaw connection state to browser clients so the chat
 * UI's connection indicator reflects the full path (browser↔Pinchy↔OpenClaw),
 * not just the browser↔Pinchy WebSocket.
 *
 * The disconnect handler closes browser sockets on first OpenClaw disconnect,
 * after which the browser auto-reconnects to Pinchy. Without this broadcaster
 * the new connection would consider itself fully healthy even while OpenClaw
 * is still down. Two channels keep the indicator in sync:
 *   • a broadcast on each OpenClaw `connected` event flips browsers to green
 *   • `sendInitialStatus(ws)` lets the WS server push the current state to a
 *     freshly-connected browser (covers the post-reconnect window when
 *     OpenClaw is still down)
 */
export function setupOpenClawStatusBroadcaster(
  openclawClient: Pick<OpenClawClient, "on" | "isConnected">,
  sessionMap: Map<WebSocket, unknown>
): {
  sendInitialStatus: (clientWs: WebSocket) => void;
} {
  let isOpenClawConnected = openclawClient.isConnected;

  openclawClient.on("connected", () => {
    isOpenClawConnected = true;
    const frame = JSON.stringify({ type: "openclaw_status", connected: true });
    for (const [ws] of sessionMap) {
      if (ws.readyState === WS_OPEN) {
        ws.send(frame);
      }
    }
  });

  openclawClient.on("disconnected", () => {
    isOpenClawConnected = false;
    // No broadcast: the disconnect handler closes browser sockets, which the
    // browser sees as `ws.onclose` and reflects as red. Once it reconnects,
    // sendInitialStatus(ws) will push the current state.
  });

  return {
    sendInitialStatus: (clientWs) => {
      if (clientWs.readyState !== WS_OPEN) return;
      clientWs.send(JSON.stringify({ type: "openclaw_status", connected: isOpenClawConnected }));
    },
  };
}
