import { parse } from "url";
import type { IncomingMessage } from "http";
import type { Duplex } from "stream";

type UpgradeHandler = (request: IncomingMessage, socket: Duplex, head: Buffer) => void;

/**
 * Routes HTTP upgrade requests on the custom server.
 *
 * Pinchy's own browser WebSocket lives at /api/ws and is handled here
 * (auth, rate limiting, ClientRouter — wired up in server.ts).
 *
 * Every OTHER upgrade path — most importantly the dev-mode HMR socket at
 * /_next/webpack-hmr — must be left completely untouched: server.ts passes
 * the http server to next() via the `httpServer` option, which makes
 * Next.js register its OWN upgrade listener (router-server's
 * upgradeHandler). That listener answers HMR upgrades and deliberately
 * skips paths it doesn't own. If we destroyed or answered those sockets
 * here, dev HMR would never connect and Next 16's hydration — which waits
 * on the HMR channel in dev — would freeze every page at its
 * server-rendered shell (the "Checking infrastructure..." hang).
 */
export function createUpgradeRouter(handlers: { handlePinchyWs: UpgradeHandler }): UpgradeHandler {
  return (request, socket, head) => {
    const { pathname } = parse(request.url ?? "", true);
    if (pathname === "/api/ws") {
      handlers.handlePinchyWs(request, socket, head);
    }
  };
}
