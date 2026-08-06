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
    const link = vi.fn().mockResolvedValue({ linked: true, id: "row-1", status: "pending" });
    attachPluginApprovalBridge(client, { link });

    client.emit("event", requested("call_7"));
    await settle();

    expect(link).toHaveBeenCalledWith({ approvalId: "plugin:abc", toolCallId: "call_7" });
  });

  it("does not touch the database for any other gateway event", async () => {
    // This listener sees EVERY event on the shared client — session messages,
    // deltas, status frames. A write per event would be a query storm.
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue({ linked: false, reason: "not-ours" });
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
    link.mockResolvedValue({ linked: true, id: "row-2", status: "pending" });
    client.emit("event", requested("call_8"));
    await settle();
    expect(link).toHaveBeenCalledTimes(2);
  });

  // An approval nobody was waiting for is OpenClaw's own (skill workshop,
  // exec), not a fault — it must not be reported as an error.
  it("treats an unmatched approval as ordinary, not as a failure", async () => {
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue({ linked: false, reason: "not-ours" });
    const onError = vi.fn();
    attachPluginApprovalBridge(client, { link, onError });

    client.emit("event", requested("call_not_ours"));
    await settle();

    expect(onError).not.toHaveBeenCalled();
  });

  // …but one of OURS that could not be linked is NOT ordinary, and used to be
  // indistinguishable from the case above. Both returned a bare null and both
  // were silent, which is why the first live occurrence took a CI log and a
  // count of gateway calls to read.
  it("says so when the approval was ours but arrived too late to link", async () => {
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue({ linked: false, reason: "settled" });
    const onLate = vi.fn();
    attachPluginApprovalBridge(client, { link, onLate });

    client.emit("event", requested("call_gone"));
    await settle();

    expect(onLate).toHaveBeenCalledWith(
      expect.objectContaining({ toolCallId: "call_gone", approvalId: "plugin:abc" })
    );
  });

  /**
   * The race this bridge exists to survive (#1132 follow-up).
   *
   * `gate-check` creates the row BEFORE the hook returns `requireApproval`, so
   * the card is clickable before OpenClaw has announced the approval. A user who
   * decides in that window leaves the decision recorded and the call parked —
   * the decision route had no id to resolve with, and never will.
   *
   * So the broadcast, not the click, is what delivers it in that case: whenever
   * it arrives, however late, a row that is already decided gets its decision
   * handed to the parked call. Event-driven on purpose — the alternative was to
   * make the route WAIT some guessed number of seconds for the broadcast, which
   * is a timing assumption dressed up as a fix.
   */
  it("delivers a decision that was made before the approval was announced", async () => {
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue({ linked: true, id: "row-1", status: "approved" });
    const resolve = vi.fn().mockResolvedValue({ delivered: true });
    attachPluginApprovalBridge(client, { link, resolve });

    client.emit("event", requested("call_early"));
    await settle();

    expect(resolve).toHaveBeenCalledWith({ approvalId: "plugin:abc", decision: "approve" });
  });

  it("delivers a denial the same way", async () => {
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue({ linked: true, id: "row-1", status: "denied" });
    const resolve = vi.fn().mockResolvedValue({ delivered: true });
    attachPluginApprovalBridge(client, { link, resolve });

    client.emit("event", requested("call_early"));
    await settle();

    expect(resolve).toHaveBeenCalledWith({ approvalId: "plugin:abc", decision: "deny" });
  });

  // The ordinary path: nobody has decided yet, so there is nothing to deliver.
  // Resolving here would answer a question the user has not been asked.
  it("does not resolve a confirmation that is still waiting for its user", async () => {
    const client = new EventEmitter();
    const link = vi.fn().mockResolvedValue({ linked: true, id: "row-1", status: "pending" });
    const resolve = vi.fn();
    attachPluginApprovalBridge(client, { link, resolve });

    client.emit("event", requested("call_7"));
    await settle();

    expect(resolve).not.toHaveBeenCalled();
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
    const link = vi.fn().mockResolvedValue({ linked: true, id: "row-1", status: "pending" });
    const detach = attachPluginApprovalBridge(client, { link });

    detach();
    client.emit("event", requested("call_7"));
    await settle();

    expect(link).not.toHaveBeenCalled();
    expect(client.listenerCount("event")).toBe(0);
  });
});
