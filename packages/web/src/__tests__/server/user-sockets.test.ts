// Real sockets, no mocks: a `ws` server on an ephemeral port and real clients.
//
// The WebSocket upgrade authenticates a user once (server.ts →
// validateWsSession) and the connection then lives for as long as the tab is
// open. Deactivating the account deletes its session rows, which stops the
// NEXT upgrade — but an already-open chat kept working, and kept running agent
// tools. The registry is how DELETE /api/users/:id reaches those sockets.

import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "fs";
import path from "path";
import { WebSocketServer, WebSocket } from "ws";
import type { AddressInfo } from "net";
import {
  UserSocketRegistry,
  ACCOUNT_DEACTIVATED_CLOSE_CODE,
  getUserSocketRegistry,
} from "@/server/user-sockets";

type Harness = { wss: WebSocketServer; url: string };
const open: Harness[] = [];

async function startServer(registry: UserSocketRegistry, userId: string): Promise<Harness> {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise<void>((resolve) => wss.once("listening", () => resolve()));
  wss.on("connection", (ws) => registry.register(userId, ws));
  const h = { wss, url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}` };
  open.push(h);
  return h;
}

async function connect(url: string) {
  const client = new WebSocket(url);
  const frames: unknown[] = [];
  client.on("message", (data) => frames.push(JSON.parse(data.toString())));
  const closed = new Promise<{ code: number; reason: string }>((resolve) =>
    client.once("close", (code, reason) => resolve({ code, reason: reason.toString() }))
  );
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
  return { client, frames, closed };
}

/** Wait until the server side has caught up (registration and close are async to the client). */
async function untilOpenOnServer(registry: UserSocketRegistry, userId: string, n: number) {
  for (let i = 0; i < 200 && registry.openSocketCount(userId) !== n; i++) {
    await new Promise((r) => setTimeout(r, 5));
  }
  expect(registry.openSocketCount(userId)).toBe(n);
}

afterEach(async () => {
  for (const h of open.splice(0)) {
    for (const c of h.wss.clients) c.terminate();
    await new Promise((r) => h.wss.close(() => r(undefined)));
  }
});

describe("UserSocketRegistry", () => {
  it("closes every open socket of a revoked user with a deactivation code and says why", async () => {
    const registry = new UserSocketRegistry();
    const { url } = await startServer(registry, "u1");
    const a = await connect(url);
    const b = await connect(url);
    await untilOpenOnServer(registry, "u1", 2);

    expect(registry.revoke("u1")).toBe(2);

    for (const c of [a, b]) {
      expect(await c.closed).toEqual({
        code: ACCOUNT_DEACTIVATED_CLOSE_CODE,
        reason: "Account deactivated",
      });
      // `policy_` makes the tab treat it as final: no Retry button, and the
      // wait for a history frame that is not coming ends (use-ws-runtime).
      expect(c.frames).toContainEqual({
        type: "error",
        code: "policy_account_deactivated",
        message: "Your account has been deactivated.",
      });
    }
    expect(registry.isRevoked("u1")).toBe(true);
  });

  it("leaves other users' sockets alone", async () => {
    const registry = new UserSocketRegistry();
    const mine = await startServer(registry, "u1");
    const theirs = await startServer(registry, "u2");
    await connect(mine.url);
    const other = await connect(theirs.url);
    await untilOpenOnServer(registry, "u1", 1);
    await untilOpenOnServer(registry, "u2", 1);

    registry.revoke("u1");

    expect(other.client.readyState).toBe(WebSocket.OPEN);
    expect(registry.isRevoked("u2")).toBe(false);
  });

  it("refuses a socket registered for a user who is already revoked", async () => {
    // The upgrade validated the session a moment before the deactivation
    // committed; the socket must not slip through that gap.
    const registry = new UserSocketRegistry();
    registry.revoke("u1");
    const { url } = await startServer(registry, "u1");

    const c = await connect(url);

    expect((await c.closed).code).toBe(ACCOUNT_DEACTIVATED_CLOSE_CODE);
    expect(registry.openSocketCount("u1")).toBe(0);
  });

  it("forgets a socket once it closes", async () => {
    const registry = new UserSocketRegistry();
    const { url } = await startServer(registry, "u1");
    const c = await connect(url);
    await untilOpenOnServer(registry, "u1", 1);

    c.client.close();
    await c.closed;

    await untilOpenOnServer(registry, "u1", 0);
  });

  it("lets a reactivated user's new sockets stay open", async () => {
    const registry = new UserSocketRegistry();
    registry.revoke("u1");
    registry.restore("u1");
    const { url } = await startServer(registry, "u1");

    const c = await connect(url);
    await untilOpenOnServer(registry, "u1", 1);

    expect(registry.isRevoked("u1")).toBe(false);
    expect(c.client.readyState).toBe(WebSocket.OPEN);
  });

  it("is fed by server.ts's upgrade, or a deactivation finds no socket to close", () => {
    // Every test above passes against a registry nobody registers into. The
    // upgrade handler is the only place a browser socket gets its user id.
    const server = readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
    // Between the upgrade and the connection event: before any message can
    // arrive on the socket.
    const upgrade = server.slice(server.indexOf("wss.handleUpgrade("));
    expect(upgrade.slice(0, upgrade.indexOf('wss.emit("connection"'))).toContain(
      "userSockets.register(userId, ws)"
    );
    expect(server).toContain("const userSockets = getUserSocketRegistry()");
  });

  it("is one registry per process, shared across module contexts", () => {
    // API routes (DELETE /api/users/:id) and server.ts may load this module
    // separately under Next.js; the instance lives on globalThis.
    expect(getUserSocketRegistry()).toBe(getUserSocketRegistry());
    expect((globalThis as Record<string, unknown>)["__pinchyUserSocketRegistry"]).toBe(
      getUserSocketRegistry()
    );
  });
});
