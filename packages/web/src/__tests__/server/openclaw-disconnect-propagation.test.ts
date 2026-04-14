import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { setupOpenClawDisconnectHandler } from "@/server/openclaw-disconnect-handler";

// When OpenClaw disconnects mid-stream, Pinchy must close all active browser
// WebSockets so the browser's existing disconnect-recovery path fires:
//   • isRunning=true  → disconnect error injected, reconnect triggered
//   • isRunning=false → just sets isConnected=false, reconnect triggered
//
// Without this, the browser stays connected to Pinchy while the server-side
// for-await loop is blocked forever (openclaw-node's chat() generator hangs
// because resolveChunk is never called after the underlying WS closes).

describe("OpenClaw disconnect propagation to browser clients", () => {
  it("closes all OPEN browser WebSockets when openclawClient emits disconnected", () => {
    const openclawClient = new EventEmitter();

    const ws1 = { readyState: 1 /* OPEN */, close: vi.fn() };
    const ws2 = { readyState: 1 /* OPEN */, close: vi.fn() };
    const wsClosed = { readyState: 3 /* CLOSED */, close: vi.fn() };

    const sessionMap = new Map<object, { userId: string }>([
      [ws1, { userId: "user-1" }],
      [ws2, { userId: "user-2" }],
      [wsClosed, { userId: "user-3" }],
    ]);

    setupOpenClawDisconnectHandler(openclawClient as any, sessionMap as any);
    openclawClient.emit("disconnected");

    expect(ws1.close).toHaveBeenCalledWith(1001, "OpenClaw disconnected");
    expect(ws2.close).toHaveBeenCalledWith(1001, "OpenClaw disconnected");
    // Already-closed WebSockets must not be touched
    expect(wsClosed.close).not.toHaveBeenCalled();
  });

  it("does not throw when there are no active browser WebSocket connections", () => {
    const openclawClient = new EventEmitter();
    const sessionMap = new Map<object, { userId: string }>();

    setupOpenClawDisconnectHandler(openclawClient as any, sessionMap as any);
    expect(() => openclawClient.emit("disconnected")).not.toThrow();
  });
});
