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
//
// IMPORTANT: openclaw-node emits "disconnected" on every failed reconnect attempt
// (~1s interval). Browser WebSockets must only be closed ONCE per "down" period,
// not on every attempt — otherwise the browser can never stay connected while
// Pinchy is waiting for OpenClaw to come back.

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

  it("does not close browser WebSockets again on subsequent disconnected events while OpenClaw is still down", () => {
    // openclaw-node fires "disconnected" on every failed reconnect attempt (~1s).
    // Without this guard the browser could never re-establish its connection to
    // Pinchy because each reconnect would be torn down almost immediately.
    const openclawClient = new EventEmitter();

    const ws = { readyState: 1 /* OPEN */, close: vi.fn() };
    const sessionMap = new Map<object, { userId: string }>([[ws, { userId: "user-1" }]]);

    setupOpenClawDisconnectHandler(openclawClient as any, sessionMap as any);

    // First disconnect — should close browser WebSockets
    openclawClient.emit("disconnected");
    expect(ws.close).toHaveBeenCalledTimes(1);

    // Simulate browser reconnecting: a new WS entry would be added, but the
    // existing one is now CLOSED (readyState 3) — simulate that
    ws.readyState = 3;
    const wsNew = { readyState: 1 /* OPEN */, close: vi.fn() };
    sessionMap.set(wsNew, { userId: "user-1" });

    // Subsequent disconnected events while OpenClaw is still down
    openclawClient.emit("disconnected");
    openclawClient.emit("disconnected");

    // New browser connection must NOT be closed by the repeated disconnect events
    expect(wsNew.close).not.toHaveBeenCalled();
  });

  it("closes browser WebSockets again after OpenClaw reconnects and then disconnects again", () => {
    const openclawClient = new EventEmitter();

    const ws = { readyState: 1 /* OPEN */, close: vi.fn() };
    const sessionMap = new Map<object, { userId: string }>([[ws, { userId: "user-1" }]]);

    setupOpenClawDisconnectHandler(openclawClient as any, sessionMap as any);

    // First disconnect period
    openclawClient.emit("disconnected");
    expect(ws.close).toHaveBeenCalledTimes(1);

    // OpenClaw comes back — resets the guard
    openclawClient.emit("connected");

    // OpenClaw goes down again — should close browser WebSockets again
    ws.readyState = 1; // simulating a new connection with same object
    openclawClient.emit("disconnected");
    expect(ws.close).toHaveBeenCalledTimes(2);
  });

  it("does not throw when there are no active browser WebSocket connections", () => {
    const openclawClient = new EventEmitter();
    const sessionMap = new Map<object, { userId: string }>();

    setupOpenClawDisconnectHandler(openclawClient as any, sessionMap as any);
    expect(() => openclawClient.emit("disconnected")).not.toThrow();
  });
});
