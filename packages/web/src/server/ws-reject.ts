import type { IncomingMessage } from "http";
import type { Duplex } from "stream";
import type { WebSocketServer } from "ws";

/**
 * Close code for an upgrade the limiter refused (#1422).
 *
 * A raw `HTTP/1.1 429` on the upgrade surfaces in the browser as close code
 * 1006 with no reason — indistinguishable from "server down", so the client
 * could only keep spinning. Completing the handshake and closing with an
 * application code (4000–4999) is the one way to hand the browser a reason it
 * can read. 4429 echoes the HTTP status it replaces.
 *
 * The client reads this value too (`use-ws-runtime.ts`); keep both in step.
 */
export const WS_REJECTED_CLOSE_CODE = 4429;

/**
 * - `too_many_connections`: the user already holds the per-user maximum of
 *   open chat sockets, across all devices.
 * - `rate_limited`: too many upgrades from this address in the last minute.
 */
export type WsRejectionReason = "too_many_connections" | "rate_limited";

/**
 * Accepts the upgrade and closes it straight away with `WS_REJECTED_CLOSE_CODE`
 * and `reason`. The socket is never emitted as a `connection`: it is not
 * counted, not registered, and no router ever sees it.
 */
export function rejectUpgrade(
  wss: WebSocketServer,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  reason: WsRejectionReason
): void {
  wss.handleUpgrade(request, socket, head, (ws) => {
    ws.on("error", () => {
      // A client that hung up before reading the close frame. Nothing to do.
    });
    ws.close(WS_REJECTED_CLOSE_CODE, reason);
  });
}
