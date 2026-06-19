// @vitest-environment node
//
// Hardening coverage for the fake-ollama server lifecycle helpers
// (startFakeOllama / stopFakeOllama). The Docker E2E stack drives the server as
// a long-lived subprocess (fake-ollama-process.ts) on the well-known
// FAKE_OLLAMA_PORT; if that port is ever already bound, startFakeOllama() must
// fail FAST and LOUD — a rejected promise — rather than hanging on a listen
// callback that never fires while its unhandled 'error' event crashes the
// process. (That exact failure mode flaked the context-window unit test and
// would silently break E2E startup on a port clash.)
//
// These in-process tests bind EPHEMERAL ports (0) so they never collide with a
// concurrent holder of the fixed 11435 themselves.
import { describe, it, expect, afterEach } from "vitest";
import * as http from "http";
import type { AddressInfo } from "net";
import {
  startFakeOllama,
  stopFakeOllama,
} from "../../../e2e/shared/fake-ollama/fake-ollama-server";

/** Bind 0.0.0.0:<ephemeral> and hold it so a subsequent listen on it collides. */
function occupyPort(): Promise<{ port: number; release: () => Promise<void> }> {
  return new Promise((resolve) => {
    const blocker = http.createServer();
    blocker.listen(0, "0.0.0.0", () => {
      const { port } = blocker.address() as AddressInfo;
      resolve({
        port,
        release: () => new Promise<void>((res, rej) => blocker.close((e) => (e ? rej(e) : res()))),
      });
    });
  });
}

afterEach(async () => {
  // Always release the module singleton between tests so the next test starts
  // from a clean slate even if a test left it running.
  await stopFakeOllama();
});

describe("startFakeOllama / stopFakeOllama lifecycle", () => {
  it("starts on the requested port and returns the actual bound port", async () => {
    const port = await startFakeOllama(0);
    expect(typeof port).toBe("number");
    expect(port).toBeGreaterThan(0);

    const res = await fetch(`http://127.0.0.1:${port}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: "llama3.2" }),
    });
    expect(res.ok).toBe(true);
  });

  // Tight timeout: the whole point of the fix is that this rejects promptly
  // rather than hanging until the default hook/test timeout.
  it(
    "rejects with EADDRINUSE instead of hanging when the port is already bound",
    { timeout: 5000 },
    async () => {
      const blocker = await occupyPort();
      try {
        await expect(startFakeOllama(blocker.port)).rejects.toMatchObject({
          code: "EADDRINUSE",
        });
      } finally {
        await blocker.release();
      }
    }
  );

  it("rejects a second start while already running (no silent server leak)", async () => {
    await startFakeOllama(0);
    await expect(startFakeOllama(0)).rejects.toThrow(/already started/i);
  });

  it("leaves no stale server after a failed start, so stop is a clean no-op", async () => {
    const blocker = await occupyPort();
    try {
      await expect(startFakeOllama(blocker.port)).rejects.toMatchObject({
        code: "EADDRINUSE",
      });
    } finally {
      await blocker.release();
    }
    // A failed start must not leave a half-constructed, never-listening server
    // behind — otherwise stop() rejects with ERR_SERVER_NOT_RUNNING.
    await expect(stopFakeOllama()).resolves.toBeUndefined();
  });
});
