/**
 * Ordered graceful-shutdown steps for the custom Next.js server (#263).
 *
 * Extracted from `server.ts` so the individual steps — including the
 * OpenClaw disconnect, browser-WebSocket drain, and DB-pool close — can be
 * unit-tested without booting the real HTTP server.
 *
 * Consumed by `registerShutdownHandlers` (see `@/lib/shutdown`), which runs
 * every step in array order on SIGTERM/SIGINT and tolerates individual
 * step failures.
 */
import { WebSocket, type WebSocketServer } from "ws";

export type ShutdownStopFn = () => void | Promise<void>;

export interface ShutdownDeps {
  stopUploadGc: ShutdownStopFn;
  stopChatErrorGc: ShutdownStopFn;
  stopAuditVerifyJob: ShutdownStopFn;
  stopUsagePoller: ShutdownStopFn;
  stopMemoryAuditWatcher: ShutdownStopFn;
  getOpenclawClient: () => { disconnect: () => void | Promise<void> } | null;
  wss: Pick<WebSocketServer, "clients" | "close">;
  closeHttpServer: () => Promise<void>;
  closeDb: () => Promise<void>;
}

/**
 * Builds the ordered array of shutdown steps. Without this ordering, a
 * SIGTERM (e.g. from Docker Compose) leaves setInterval handles, the
 * OpenClaw WS connection, and/or idle browser WS clients dangling, and the
 * process hangs until the container's kill-grace period expires.
 */
export function buildShutdownSteps(deps: ShutdownDeps): ShutdownStopFn[] {
  return [
    () => deps.stopUploadGc(),
    () => deps.stopChatErrorGc(),
    () => deps.stopAuditVerifyJob(),
    () => deps.stopUsagePoller(),
    () => deps.stopMemoryAuditWatcher(),
    // Disconnect from the OpenClaw Gateway cleanly so the WS + its in-flight
    // RPCs don't dangle past the HTTP server close (#263). The client is
    // assigned later in boot; the getter reads it at shutdown time.
    () => deps.getOpenclawClient()?.disconnect() ?? Promise.resolve(),
    // Drain browser WebSockets: close each client (1001 = going away) then
    // close the WS server. Without this `docker compose down` hits the 30s
    // SIGKILL timeout because idle WS clients keep the event loop alive past
    // `server.close()` (#263).
    () =>
      new Promise<void>((resolve) => {
        for (const ws of deps.wss.clients as Set<WebSocket>) {
          if (ws.readyState === WebSocket.OPEN) ws.close(1001, "server shutting down");
        }
        deps.wss.close(() => resolve());
      }),
    () => deps.closeHttpServer(),
    // Close the DB pool last, after in-flight requests (drained by
    // server.close) have settled. `timeout: 5` lets running queries finish.
    () => deps.closeDb(),
  ];
}
