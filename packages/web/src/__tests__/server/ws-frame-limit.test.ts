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
/**
 * Open a WebSocket to the local test server, retrying the CONNECT phase on
 * transient handshake failures (bounded, fresh socket per attempt).
 *
 * Why: under full-suite load (many vitest forks + local Docker stacks) a
 * single-shot localhost TCP/WS handshake can fail with `socket hang up`
 * (ECONNRESET during the HTTP upgrade) — pure environmental noise that has
 * nothing to do with this file's contract, which is the server's `maxPayload`
 * behaviour AFTER a connection exists. Retrying only the connect phase removes
 * that noise without weakening the contract: every assertion still runs
 * against a real connection, and a maxPayload regression fails exactly as
 * before.
 */
async function connectWithRetry(port: number, attempts = 3): Promise<WebSocket> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    const client = new WebSocket(`ws://127.0.0.1:${port}`);
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", reject);
      });
      return client;
    } catch (err) {
      lastError = err;
      client.terminate();
      await new Promise((r) => setTimeout(r, 100 * (i + 1)));
    }
  }
  throw lastError;
}

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

    const client = await connectWithRetry(port);

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

  it("rejects a frame larger than the server limit with close code 1009 (negative guard)", async () => {
    // The /review feedback flagged that the positive test alone is not enough:
    // someone could set maxPayload to Infinity and the positive test would still
    // pass. This test pins down the *upper* end of the contract — frames over
    // the limit must be rejected with 1009 ("Message too big"), which is what
    // the client-side handler in use-ws-runtime.ts uses to surface "Image too
    // large".
    let messageReceived = false;
    wss.on("connection", (ws) => {
      ws.on("message", () => {
        messageReceived = true;
      });
      // The `ws` library emits an "error" event with WS_ERR_UNSUPPORTED_MESSAGE_LENGTH
      // when an oversized frame arrives. Without a listener Node treats it as
      // unhandled and Vitest fails the test even though the close code is what
      // we're asserting on. Swallow it — the close code is the contract.
      ws.on("error", () => {});
    });

    const client = await connectWithRetry(port);

    const closeEvent = new Promise<{ code: number }>((resolve) => {
      client.once("close", (code) => resolve({ code }));
    });

    // Just over the limit — guaranteed to trigger maxPayload rejection.
    const oversized = "x".repeat(SERVER_WS_MAX_PAYLOAD_BYTES + 1);
    client.send(oversized);

    const { code } = await closeEvent;
    expect(code).toBe(1009);
    expect(messageReceived).toBe(false);
  });
});
