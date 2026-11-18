import type { Duplex } from "stream";

/**
 * Refuses a chat upgrade the limiter turned down, with a plain HTTP 429 (#1422).
 *
 * Deliberately not a completed handshake closed with an application close code,
 * even though that would hand the browser a reason it can read: a browser fires
 * `open` for a completed handshake, and the chat client resets its reconnect
 * backoff on `open`. Refused after the handshake, it would redial about once a
 * second and keep the very limit that refused it saturated — worst right after
 * an upgrade, when every open tab reconnects at once with the JavaScript it
 * loaded before. A refused upgrade reaches the browser as a failed dial, and
 * every client version backs off from that.
 */
export function refuseUpgrade(socket: Duplex): void {
  socket.write("HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\n\r\n");
  socket.destroy();
}
