import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket, type AddressInfo } from "ws";
import { createServer, type Server as HttpServer } from "node:http";
import { rejectUpgrade, WS_REJECTED_CLOSE_CODE, type WsRejectionReason } from "@/server/ws-reject";

/**
 * A raw `HTTP/1.1 429` on the upgrade reaches the browser as a bare close code
 * 1006 — the same code as "server down". The client then cannot tell the user
 * why, and can only keep spinning (#1422 case 1). Accepting the upgrade and
 * closing with an application close code makes the reason readable: the
 * browser's CloseEvent carries both `code` and `reason`.
 */

let httpServer: HttpServer | undefined;
let wss: WebSocketServer | undefined;

afterEach(async () => {
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) =>
    httpServer ? httpServer.close(() => resolve()) : resolve()
  );
  wss = undefined;
  httpServer = undefined;
});

async function startRejectingServer(reason: WsRejectionReason) {
  httpServer = createServer();
  wss = new WebSocketServer({ noServer: true });
  const server = wss;
  httpServer.on("upgrade", (request, socket, head) => {
    rejectUpgrade(server, request, socket, head, reason);
  });
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
  return { port: (httpServer.address() as AddressInfo).port, wss: server };
}

function closeOf(port: number): Promise<{ code: number; reason: string; opened: boolean }> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 5_000 });
    let opened = false;
    client.on("open", () => (opened = true));
    client.on("unexpected-response", (_req, res) =>
      reject(new Error(`upgrade answered with HTTP ${res.statusCode}`))
    );
    client.on("close", (code, reason) => resolve({ code, reason: reason.toString(), opened }));
    client.on("error", () => {});
  });
}

describe("rejectUpgrade", () => {
  it.each<WsRejectionReason>(["too_many_connections", "rate_limited"])(
    "completes the handshake and closes with %s under the app close code",
    async (reason) => {
      const { port } = await startRejectingServer(reason);
      const result = await closeOf(port);
      expect(result).toEqual({ code: WS_REJECTED_CLOSE_CODE, reason, opened: true });
    }
  );

  it("uses a code in the application range a browser passes through", () => {
    // 4000–4999 is reserved for applications; anything below is either the
    // protocol's own (1000–2999) or a library's (3000–3999).
    expect(WS_REJECTED_CLOSE_CODE).toBeGreaterThanOrEqual(4000);
    expect(WS_REJECTED_CLOSE_CODE).toBeLessThan(5000);
  });

  it("never hands the rejected socket to the connection handler", async () => {
    const { port, wss: server } = await startRejectingServer("too_many_connections");
    const onConnection = vi.fn();
    server.on("connection", onConnection);
    await closeOf(port);
    expect(onConnection).not.toHaveBeenCalled();
  });
});
