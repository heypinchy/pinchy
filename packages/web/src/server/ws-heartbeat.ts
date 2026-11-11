import type { WebSocket, WebSocketServer } from "ws";

/**
 * Liveness for browser sockets on `/api/ws`, in both directions (#1422).
 *
 * **Server → browser: protocol ping.** A browser that vanishes without a close
 * frame (lid shut, network switch, VPN toggle) leaves a half-open socket that
 * emits neither `close` nor `error` until the OS gives up on the TCP
 * connection — hours, sometimes. Until then it holds one of the user's
 * `WsRateLimiter` slots, and enough of them lock the user out of chat on
 * every device. Every tick pings each socket; one that has shown no sign of
 * life since the previous tick is terminated, which emits `close` and runs the
 * same release path as any other disconnect.
 *
 * **Browser → server: application ping.** Browsers can neither send a
 * protocol ping nor observe one, so the client detects its own half-open
 * socket with a `{ type: "ping" }` frame and a deadline. `answerAppHeartbeat`
 * answers it.
 */

/**
 * A dead peer is cut off between one and two intervals after it went quiet.
 * 30 s keeps that well under a minute while costing one ~2-byte frame per
 * socket per tick, and stays below the ~60 s idle timeout common reverse
 * proxies apply — so the ping also keeps a healthy, quiet chat from being cut
 * by the proxy in front of Pinchy.
 */
export const WS_HEARTBEAT_INTERVAL_MS = 30_000;

export function startWsHeartbeat(
  wss: WebSocketServer,
  options: { intervalMs?: number } = {}
): { stop: () => void } {
  const intervalMs = options.intervalMs ?? WS_HEARTBEAT_INTERVAL_MS;
  // Sockets pinged in the last tick that have not answered (or sent anything)
  // since. Weak so a socket closed between ticks is not kept alive by us.
  const awaiting = new WeakSet<WebSocket>();
  const watched = new WeakSet<WebSocket>();

  const markAlive = (ws: WebSocket) => () => awaiting.delete(ws);

  const tick = () => {
    for (const ws of wss.clients) {
      if (!watched.has(ws)) {
        // Attached lazily rather than on `connection`: server.ts emits that
        // event itself after its own checks, and a socket the heartbeat never
        // saw would be a socket it never cuts off.
        watched.add(ws);
        const alive = markAlive(ws);
        ws.on("pong", alive);
        // Any inbound frame proves the peer is there; a busy client's pong can
        // sit behind its own data.
        ws.on("message", alive);
      } else if (awaiting.has(ws)) {
        ws.terminate();
        continue;
      }
      awaiting.add(ws);
      try {
        ws.ping();
      } catch {
        // The socket is closing; its own `close` handler does the cleanup.
      }
    }
  };

  const timer = setInterval(tick, intervalMs);
  // Never the reason the process stays up, e.g. during a graceful shutdown.
  timer.unref?.();
  const stop = () => clearInterval(timer);
  wss.once("close", stop);
  return { stop };
}

/**
 * Answers the client's application-level heartbeat. Returns true when the frame
 * was a heartbeat — handled here, and never passed on to the router (it must
 * work while no router exists, i.e. before OpenClaw is configured).
 */
export function answerAppHeartbeat(ws: WebSocket, frame: unknown): boolean {
  if (typeof frame !== "object" || frame === null) return false;
  if ((frame as { type?: unknown }).type !== "ping") return false;
  // 1 === WebSocket.OPEN; `ws` is imported for its types only.
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "pong" }));
  return true;
}
