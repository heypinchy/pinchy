import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer, WebSocket, type AddressInfo } from "ws";
import { createServer, type Server as HttpServer } from "node:http";
import { SERVER_WS_MAX_PAYLOAD_BYTES } from "@/lib/limits";

/**
 * Reproduces the production "Connection lost" failure (issue: image attachments
 * in chat). The fix raises the server's `maxPayload` from 1 MB to a value that
 * covers realistic smartphone photos. This test guards against regressing back
 * to a too-small limit.
 *
 * The test boots a minimal `ws.WebSocketServer` with the same `maxPayload`
 * production uses (via the shared SERVER_WS_MAX_PAYLOAD_BYTES constant), sends
 * a 5 MB JSON frame, and asserts the server delivers the message instead of
 * closing with code 1009 ("Message too big").
 */
describe("WebSocket server frame limit (regression guard)", () => {
  let httpServer: HttpServer;
  let wss: WebSocketServer;
  let port: number;

  beforeEach(async () => {
    httpServer = createServer();
    wss = new WebSocketServer({
      server: httpServer,
      // Mirror the production setting from server.ts via the shared constant.
      // When this is too small the server closes the connection with code 1009
      // instead of delivering the frame, which surfaces in the UI as
      // "Connection lost".
      maxPayload: SERVER_WS_MAX_PAYLOAD_BYTES,
    });
    await new Promise<void>((resolve) => httpServer.listen(0, resolve));
    port = (httpServer.address() as AddressInfo).port;
  });

  afterEach(async () => {
    wss.close();
    await new Promise<void>((resolve) => httpServer.close(() => resolve()));
  });

  it("accepts a 5 MB JSON frame (representative of a high-res image attachment)", async () => {
    const received = new Promise<string>((resolve, reject) => {
      wss.on("connection", (ws) => {
        ws.on("message", (data) => resolve(data.toString()));
        ws.on("close", (code, reason) =>
          reject(new Error(`server closed before message: code=${code} reason=${reason}`))
        );
      });
    });

    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve, reject) => {
      client.once("open", () => resolve());
      client.once("error", reject);
    });

    // 5 MB of base64-ish content, wrapped in a JSON message so it mirrors what
    // the real router parses.
    const payload = JSON.stringify({
      type: "message",
      content: "x".repeat(5 * 1024 * 1024),
    });
    client.send(payload);

    const echoed = await received;
    expect(echoed.length).toBe(payload.length);
    client.close();
  });
});
