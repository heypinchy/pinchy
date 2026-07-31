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
 * Bound for ONE connect attempt — the fix for this file's load-induced flake.
 *
 * The flake reported it as "Test timed out", which reads as "5 MB is slow under
 * load". It is not. Measured end-to-end (connect plus the full 5 MB round trip):
 * 22 ms in isolation, 52–94 ms under 2.5× CPU oversubscription, and 28–61 ms
 * inside a full `pnpm test` run at load average 25 — that last one with ~0 ms
 * event-loop lag. Contention moves this test by a factor of 4. A timeout needs
 * a factor of 200, so what ends it is a stall, not a slowdown.
 *
 * `ws` sets no handshake timeout by default, and that is where a stall used to
 * become unbounded: a stalled upgrade — the loaded-loopback sibling of the
 * `socket hang up` the retry loop below was written for — emits neither `open`
 * nor `error`, so the loop could never retry the one failure shape it exists
 * for, and the wait was bounded only by the suite's testTimeout. Verified
 * against a server that accepts TCP and never answers the upgrade: still
 * hanging after 20 s without this option, "Opening handshake has timed out"
 * after 6.6 s with it.
 *
 * 2 s is ~75× the observed handshake (4–27 ms, isolated and under 2.5× CPU
 * oversubscription), so a merely slow handshake is still awaited to completion.
 * Only a stall is cut short and retried.
 *
 * The worst case this can cost — 3 attempts × 2 s plus 100/200 ms backoff =
 * 6.3 s — has to stay comfortably inside vitest.config.ts's `testTimeout`
 * (20 s). A retry budget that cannot finish inside the deadline is not bounded
 * at all: the run reports a timeout and hides the error that names the cause.
 */
const HANDSHAKE_TIMEOUT_MS = 2_000;

const CONNECT_ATTEMPTS = 3;

/**
 * Open a WebSocket to the local test server and return BOTH ends, retrying the
 * CONNECT phase on transient handshake failures (bounded, fresh socket per
 * attempt).
 *
 * Why retry: under full-suite load (many vitest forks + local Docker stacks) a
 * single-shot localhost TCP/WS handshake can fail with `socket hang up`
 * (ECONNRESET during the HTTP upgrade) or stall outright — environmental noise
 * that has nothing to do with this file's contract, which is the server's
 * `maxPayload` behaviour AFTER a connection exists. Retrying only the connect
 * phase removes that noise without weakening the contract: every assertion
 * still runs against a real connection, and a maxPayload regression fails
 * exactly as before.
 *
 * Why it hands back the server-side socket too: an attempt that fails after the
 * server already accepted leaves a socket behind, and that socket emits `close`
 * when we discard it. A test listening to `wss` at large cannot tell that
 * `close` apart from the live connection being dropped — it would fail with
 * "server closed before message" on a connection that is perfectly healthy.
 * Returning the socket that belongs to the connection we keep lets each test
 * listen to that one only.
 */
async function connectPair(
  wss: WebSocketServer,
  port: number,
  attempts = CONNECT_ATTEMPTS
): Promise<{ client: WebSocket; server: WebSocket }> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    // Claim this attempt's server-side socket before the client exists, so a
    // socket accepted for this attempt can never be picked up by a later one.
    let onConnection!: (ws: WebSocket) => void;
    const serverSocket = new Promise<WebSocket>((resolve) => {
      onConnection = resolve;
      wss.once("connection", onConnection);
    });
    const client = new WebSocket(`ws://127.0.0.1:${port}`, {
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    try {
      await new Promise<void>((resolve, reject) => {
        client.once("open", () => resolve());
        client.once("error", reject);
      });
      // The server emits "connection" when it writes the 101 response, i.e.
      // before the client can see "open" — this await is already settled.
      return { client, server: await serverSocket };
    } catch (err) {
      lastError = err;
      client.terminate();
      // Drop this attempt's listener so it cannot consume the next attempt's
      // connection, and discard the socket if the server did accept one.
      wss.off("connection", onConnection);
      void serverSocket.then((ws) => {
        ws.on("error", () => {});
        ws.terminate();
      });
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
    const { client, server } = await connectPair(wss, port);

    const received = new Promise<string>((resolve, reject) => {
      server.on("message", (data) => resolve(data.toString()));
      server.on("close", (code, reason) =>
        reject(new Error(`server closed before message: code=${code} reason=${reason}`))
      );
      // A maxPayload regression makes the receiver emit "error" besides
      // closing with 1009. Without a listener that is an unhandled 'error'
      // event, and the run reports a timeout instead of naming the cause.
      server.on("error", (err) => reject(err));
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

  it("rejects a frame larger than the server limit with close code 1009 (negative guard)", async () => {
    // The /review feedback flagged that the positive test alone is not enough:
    // someone could set maxPayload to Infinity and the positive test would still
    // pass. This test pins down the *upper* end of the contract — frames over
    // the limit must be rejected with 1009 ("Message too big"), which is what
    // the client-side handler in use-ws-runtime.ts uses to surface "Image too
    // large".
    const { client, server } = await connectPair(wss, port);

    let messageReceived = false;
    server.on("message", () => {
      messageReceived = true;
    });
    // The `ws` library emits an "error" event with WS_ERR_UNSUPPORTED_MESSAGE_LENGTH
    // when an oversized frame arrives. Without a listener Node treats it as
    // unhandled and Vitest fails the test even though the close code is what
    // we're asserting on. Swallow it — the close code is the contract.
    server.on("error", () => {});

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
