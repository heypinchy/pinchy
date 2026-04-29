import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { setupOpenClawStatusBroadcaster } from "@/server/openclaw-status-broadcaster";

// The connection-status indicator in the chat UI must reflect upstream OpenClaw
// state, not just the browser↔Pinchy WS state. The disconnect handler closes
// browser sockets on first OpenClaw disconnect, but the browser auto-reconnects
// and would otherwise see "isConnected = true" while OpenClaw is still down.
//
// This broadcaster:
//   • emits an `openclaw_status` frame to all browsers when OpenClaw reconnects
//     (so the indicator can flip back to green without a round-trip)
//   • sends the current status to any newly-connected browser via
//     `sendInitialStatus(ws)` — this covers the post-reconnect window while
//     OpenClaw is still down

describe("setupOpenClawStatusBroadcaster", () => {
  it("broadcasts openclaw_status: true to all OPEN browser WebSockets when openclaw connects", () => {
    const openclawClient = Object.assign(new EventEmitter(), { isConnected: false });
    const ws1 = { readyState: 1 /* OPEN */, send: vi.fn() };
    const ws2 = { readyState: 1 /* OPEN */, send: vi.fn() };
    const wsClosed = { readyState: 3 /* CLOSED */, send: vi.fn() };
    const sessionMap = new Map<object, { userId: string }>([
      [ws1, { userId: "u1" }],
      [ws2, { userId: "u2" }],
      [wsClosed, { userId: "u3" }],
    ]);

    setupOpenClawStatusBroadcaster(openclawClient as any, sessionMap as any);
    openclawClient.emit("connected");

    const expected = JSON.stringify({ type: "openclaw_status", connected: true });
    expect(ws1.send).toHaveBeenCalledWith(expected);
    expect(ws2.send).toHaveBeenCalledWith(expected);
    expect(wsClosed.send).not.toHaveBeenCalled();
  });

  it("sendInitialStatus sends the current connected state to a newly-connected browser", () => {
    const openclawClient = Object.assign(new EventEmitter(), { isConnected: true });
    const sessionMap = new Map<object, { userId: string }>();
    const { sendInitialStatus } = setupOpenClawStatusBroadcaster(
      openclawClient as any,
      sessionMap as any
    );

    const ws = { readyState: 1 /* OPEN */, send: vi.fn() };
    sendInitialStatus(ws as any);
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "openclaw_status", connected: true })
    );
  });

  it("sendInitialStatus reflects disconnect after a 'disconnected' event was emitted", () => {
    const openclawClient = Object.assign(new EventEmitter(), { isConnected: true });
    const sessionMap = new Map<object, { userId: string }>();
    const { sendInitialStatus } = setupOpenClawStatusBroadcaster(
      openclawClient as any,
      sessionMap as any
    );

    openclawClient.emit("disconnected");

    const ws = { readyState: 1 /* OPEN */, send: vi.fn() };
    sendInitialStatus(ws as any);
    expect(ws.send).toHaveBeenCalledWith(
      JSON.stringify({ type: "openclaw_status", connected: false })
    );
  });

  it("does not throw when there are no active browser WebSocket connections", () => {
    const openclawClient = Object.assign(new EventEmitter(), { isConnected: false });
    const sessionMap = new Map<object, { userId: string }>();

    setupOpenClawStatusBroadcaster(openclawClient as any, sessionMap as any);
    expect(() => openclawClient.emit("connected")).not.toThrow();
  });
});
