import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { attachPluginApprovalBridge } from "@/server/plugin-approval-bridge";

/**
 * #1132. OpenClaw suspends the gated call and announces the approval on the
 * gateway. This listener is the half that hears it — without it the run stays
 * parked until it times out, no matter what the user clicks.
 */
function requested(toolCallId: string, approvalId = "plugin:abc") {
  return {
    event: "plugin.approval.requested",
    payload: { id: approvalId, request: { toolName: "odoo_write", toolCallId } },
  };
}

/** Let the handler's promise chain settle — `emit` itself is synchronous. */
const settle = () => new Promise((r) => setImmediate(r));

describe("attachPluginApprovalBridge", () => {
  it("links an arriving approval to the confirmation waiting for that call", async () => {
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue({ id: "row-1" });
    attachPluginApprovalBridge(client, { link });

    client.emit("event", requested("call_7"));
    await settle();

    expect(link).toHaveBeenCalledWith({ approvalId: "plugin:abc", toolCallId: "call_7" });
  });

  it("does not touch the database for any other gateway event", async () => {
    // This listener sees EVERY event on the shared client — session messages,
    // deltas, status frames. A write per event would be a query storm.
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue(null);
    attachPluginApprovalBridge(client, { link });

    client.emit("event", { event: "session.message", payload: { messageId: "m1" } });
    client.emit("event", { event: "plugin.approval.resolved", payload: { id: "plugin:abc" } });
    await settle();

    expect(link).not.toHaveBeenCalled();
  });

  // The emitter calls listeners synchronously, so a rejected promise from the
  // handler is an UNHANDLED rejection — which takes the Pinchy server process
  // down. A database blip during one approval must cost that approval, not the
  // whole install.
  it("survives a failing link without an unhandled rejection", async () => {
    const client = new EventEmitter();
    const link = vi.fn().mockRejectedValue(new Error("connection terminated"));
    const onError = vi.fn();
    attachPluginApprovalBridge(client, { link, onError });

    expect(() => client.emit("event", requested("call_7"))).not.toThrow();
    await settle();

    expect(onError).toHaveBeenCalled();
    // Still listening: one bad event must not deafen the bridge.
    link.mockResolvedValue({ id: "row-2" });
    client.emit("event", requested("call_8"));
    await settle();
    expect(link).toHaveBeenCalledTimes(2);
  });

  // An approval nobody was waiting for is OpenClaw's own (skill workshop,
  // exec), not a fault — it must not be reported as an error.
  it("treats an unmatched approval as ordinary, not as a failure", async () => {
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue(null);
    const onError = vi.fn();
    attachPluginApprovalBridge(client, { link, onError });

    client.emit("event", requested("call_not_ours"));
    await settle();

    expect(onError).not.toHaveBeenCalled();
  });

  // Every test above proves the bridge WORKS. None of them proves it is
  // plugged in, and an unattached bridge is indistinguishable from no bridge:
  // the suite stays green while every gated call hangs until it times out.
  // Same lesson as the X-Frame-Options gate — assert what the running system
  // does, not what a module offers.
  it("is attached in server.ts, or it never hears anything", () => {
    const server = readFileSync(path.join(process.cwd(), "server.ts"), "utf8");
    expect(server).toContain("attachPluginApprovalBridge(openclawClient)");
  });

  it("detaches on teardown so a re-attach cannot double-link", async () => {
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue({ id: "row-1" });
    const detach = attachPluginApprovalBridge(client, { link });

    detach();
    client.emit("event", requested("call_7"));
    await settle();

    expect(link).not.toHaveBeenCalled();
    expect(client.listenerCount("event")).toBe(0);
  });
});
