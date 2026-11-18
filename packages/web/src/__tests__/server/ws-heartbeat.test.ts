import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocketServer, WebSocket, type AddressInfo } from "ws";
import { createServer, type Server as HttpServer } from "node:http";
import { answerAppHeartbeat, startWsHeartbeat } from "@/server/ws-heartbeat";
import { WsRateLimiter } from "@/server/ws-rate-limit";

/**
 * A browser that vanishes without a close frame (laptop lid shut, network
 * switch, VPN toggle) leaves a half-open socket behind. It emits neither
 * `close` nor `error` until the OS gives up on the TCP connection, which can
 * take hours — and until then it holds one of the user's per-user connection
 * slots (#1422 case 2). The heartbeat is what turns that silence into a
 * `close`, so these tests run real sockets: the claim is about what `ws`
 * does on the wire, not about which functions get called.
 */

const INTERVAL_MS = 40;

let httpServer: HttpServer | undefined;
let wss: WebSocketServer | undefined;
const clients: WebSocket[] = [];

afterEach(async () => {
  for (const c of clients.splice(0)) {
    c.on("error", () => {});
    c.terminate();
  }
  await new Promise<void>((resolve) => (wss ? wss.close(() => resolve()) : resolve()));
  await new Promise<void>((resolve) =>
    httpServer ? httpServer.close(() => resolve()) : resolve()
  );
  wss = undefined;
  httpServer = undefined;
});

async function startServer(): Promise<{ port: number; wss: WebSocketServer }> {
  httpServer = createServer();
  wss = new WebSocketServer({ server: httpServer });
  await new Promise<void>((resolve) => httpServer!.listen(0, "127.0.0.1", resolve));
  return { port: (httpServer.address() as AddressInfo).port, wss };
}

async function connect(
  server: WebSocketServer,
  port: number,
  options: { autoPong?: boolean } = {}
): Promise<{ client: WebSocket; server: WebSocket }> {
  const serverSide = new Promise<WebSocket>((resolve) => server.once("connection", resolve));
  const client = new WebSocket(`ws://127.0.0.1:${port}`, {
    handshakeTimeout: 5_000,
    autoPong: options.autoPong ?? true,
  });
  clients.push(client);
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  return { client, server: await serverSide };
}

describe("startWsHeartbeat", () => {
  it("terminates a peer that stops answering pings, which releases its connection slot", async () => {
    const { port, wss: server } = await startServer();
    // Wired the way server.ts wires it: track on connect, release on close.
    const limiter = new WsRateLimiter({ maxConnectionsPerUser: 1 });
    server.on("connection", (ws) => {
      limiter.trackConnection("user-1");
      ws.on("close", () => limiter.releaseConnection("user-1"));
    });
    const heartbeat = startWsHeartbeat(server, { intervalMs: INTERVAL_MS });

    // `autoPong: false` is a peer that is gone: the socket is open, nothing answers.
    const { server: serverSide } = await connect(server, port, { autoPong: false });
    expect(limiter.allowConnection("user-1")).toBe(false);

    const closed = new Promise<void>((resolve) => serverSide.once("close", () => resolve()));
    await closed;

    expect(limiter.allowConnection("user-1")).toBe(true);
    heartbeat.stop();
  });

  it("keeps a peer that answers pings open across many intervals", async () => {
    const { port, wss: server } = await startServer();
    const heartbeat = startWsHeartbeat(server, { intervalMs: INTERVAL_MS });
    const { server: serverSide } = await connect(server, port);
    const onClose = vi.fn();
    serverSide.on("close", onClose);

    let pings = 0;
    serverSide.on("pong", () => pings++);
    await vi.waitFor(() => expect(pings).toBeGreaterThanOrEqual(5), { timeout: 5_000 });

    expect(onClose).not.toHaveBeenCalled();
    expect(serverSide.readyState).toBe(WebSocket.OPEN);
    heartbeat.stop();
  });

  it("counts any inbound frame as a sign of life, not only a pong", async () => {
    const { port, wss: server } = await startServer();
    const heartbeat = startWsHeartbeat(server, { intervalMs: INTERVAL_MS });
    const { client, server: serverSide } = await connect(server, port, { autoPong: false });
    const onClose = vi.fn();
    serverSide.on("close", onClose);

    // A peer busy sending is alive even if its pong is queued behind the data.
    const chatter = setInterval(() => client.send("{}"), INTERVAL_MS / 4);
    await new Promise((r) => setTimeout(r, INTERVAL_MS * 6));
    clearInterval(chatter);

    expect(onClose).not.toHaveBeenCalled();
    heartbeat.stop();
  });

  it("stops pinging once stopped", async () => {
    const { port, wss: server } = await startServer();
    const heartbeat = startWsHeartbeat(server, { intervalMs: INTERVAL_MS });
    const { client } = await connect(server, port);
    heartbeat.stop();

    const onPing = vi.fn();
    client.on("ping", onPing);
    await new Promise((r) => setTimeout(r, INTERVAL_MS * 4));
    expect(onPing).not.toHaveBeenCalled();
  });

  it("stops by itself when the server closes, so no interval outlives it", async () => {
    const { wss: server } = await startServer();
    const clearSpy = vi.spyOn(globalThis, "clearInterval");
    startWsHeartbeat(server, { intervalMs: INTERVAL_MS });
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
    wss = undefined;
  });
});

describe("answerAppHeartbeat", () => {
  /**
   * A browser cannot send a protocol-level ping, and cannot see the pings the
   * server sends. So the client detects a half-open socket (#1422 case 8) with
   * an application frame, and the server must answer it without a router —
   * `router` is null while OpenClaw is unconfigured, which is exactly when the
   * client still needs to know its socket is alive.
   */
  function fakeSocket(readyState: number = WebSocket.OPEN) {
    return { readyState, send: vi.fn() } as unknown as WebSocket & {
      send: ReturnType<typeof vi.fn>;
    };
  }

  it("answers a ping frame with a pong frame and reports it handled", () => {
    const ws = fakeSocket();
    expect(answerAppHeartbeat(ws, { type: "ping" })).toBe(true);
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: "pong" }));
  });

  it("leaves every other frame to the router", () => {
    const ws = fakeSocket();
    expect(answerAppHeartbeat(ws, { type: "message", content: "hi" })).toBe(false);
    expect(answerAppHeartbeat(ws, { type: "history" })).toBe(false);
    expect(answerAppHeartbeat(ws, null)).toBe(false);
    expect(answerAppHeartbeat(ws, "ping")).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
  });

  it("swallows a ping on a socket that is already closing", () => {
    const ws = fakeSocket(WebSocket.CLOSING);
    expect(answerAppHeartbeat(ws, { type: "ping" })).toBe(true);
    expect(ws.send).not.toHaveBeenCalled();
  });
});
