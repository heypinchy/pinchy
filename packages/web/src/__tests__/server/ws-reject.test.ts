import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket, type AddressInfo } from "ws";
import { createServer, type Server as HttpServer } from "node:http";
import { refuseUpgrade } from "@/server/ws-reject";

/**
 * A limiter refusal must never complete the handshake (#1422). A browser fires
 * `open` for a completed one, and the chat client resets its reconnect backoff
 * on `open`: refused after the handshake, it redials about once a second and
 * keeps the very limit that refused it saturated. A refused upgrade reaches the
 * browser as a failed dial, which every client version backs off from.
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

async function startRefusingServer() {
  httpServer = createServer();
  wss = new WebSocketServer({ noServer: true });
  httpServer.on("upgrade", (_request, socket) => refuseUpgrade(socket));
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
  return { port: (httpServer.address() as AddressInfo).port, wss };
}

function dial(port: number): Promise<{ status: number | null; opened: boolean }> {
  return new Promise((resolve) => {
    const client = new WebSocket(`ws://127.0.0.1:${port}`, { handshakeTimeout: 5_000 });
    let opened = false;
    client.on("open", () => (opened = true));
    client.on("unexpected-response", (_req, res) => {
      resolve({ status: res.statusCode ?? null, opened });
      client.terminate();
    });
    client.on("close", () => resolve({ status: null, opened }));
    client.on("error", () => {});
  });
}

describe("refuseUpgrade", () => {
  it("answers HTTP 429 and never opens the socket", async () => {
    const { port } = await startRefusingServer();
    expect(await dial(port)).toEqual({ status: 429, opened: false });
  });

  it("never hands the refused socket to the connection handler", async () => {
    const { port, wss: server } = await startRefusingServer();
    const onConnection = vi.fn();
    server.on("connection", onConnection);
    await dial(port);
    expect(onConnection).not.toHaveBeenCalled();
  });
});
