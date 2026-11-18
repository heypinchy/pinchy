import { describe, it, expect } from "vitest";
import { readApprovalRequested } from "@/lib/approvals/broadcast";

/**
 * #1132. OpenClaw mints its own id when it suspends a call and announces it on
 * the gateway. Pinchy has to pick ITS approvals out of that stream — the same
 * broadcast carries OpenClaw's own (skill workshop, exec) — and learn the id,
 * because resolving one later needs it.
 */
function requested(over: Record<string, unknown> = {}) {
  return {
    event: "plugin.approval.requested",
    payload: {
      id: "plugin:abc-123",
      createdAtMs: 1,
      expiresAtMs: 2,
      request: {
        pluginId: "pinchy-approvals",
        title: "Update a record",
        description: "Odoo: write",
        toolName: "odoo_write",
        toolCallId: "call_7",
        sessionKey: "agent:a1:direct:u1",
        ...over,
      },
    },
  };
}

describe("readApprovalRequested", () => {
  it("reads the approval id and the call it is holding up", () => {
    expect(readApprovalRequested(requested())).toEqual({
      approvalId: "plugin:abc-123",
      toolCallId: "call_7",
      sessionKey: "agent:a1:direct:u1",
    });
  });

  // A tool call id is only as unique as the model provider makes it. Several
  // self-hosted OpenAI-compatible servers number them per response (`call_0`,
  // `call_1`), and Pinchy explicitly supports those deployments — so two people
  // on two agents can hold pending confirmations under the same id at the same
  // moment. The session is what tells those apart, and OpenClaw already carries
  // it verbatim on the approval record (`sessionKey: p.sessionKey ?? null`,
  // fed from the same hook ctx the gate read).
  it("reads the session the call belongs to, so a shared call id cannot cross wires", () => {
    const other = readApprovalRequested(requested({ sessionKey: "agent:a2:direct:u2" }));
    expect(other?.sessionKey).toBe("agent:a2:direct:u2");
  });

  // Narrowing must never cost a link that works today: an approval without a
  // session still resolves by call id alone, exactly as before.
  it("still reads an approval that names no session", () => {
    const event = requested();
    delete (event.payload.request as Record<string, unknown>).sessionKey;
    expect(readApprovalRequested(event)).toEqual({
      approvalId: "plugin:abc-123",
      toolCallId: "call_7",
    });
  });

  it("ignores every other gateway event", () => {
    // This runs on EVERY event the gateway sends — session messages, status
    // frames, deltas. Anything but the one event must fall straight through.
    expect(readApprovalRequested({ event: "session.message", payload: {} })).toBeNull();
    expect(readApprovalRequested({ event: "plugin.approval.resolved", payload: {} })).toBeNull();
  });

  // An approval with no toolCallId is not one of ours: every Pinchy
  // confirmation is opened from a before_tool_call hook that carries the id.
  // Matching on anything looser could resolve a call the user never saw.
  it("ignores an approval that names no tool call", () => {
    const event = requested();
    delete (event.payload.request as Record<string, unknown>).toolCallId;
    expect(readApprovalRequested(event)).toBeNull();
  });

  // A throw here would kill the listener for the one event it understands, so
  // a shape it cannot read has to be a quiet null — not an exception.
  it("returns null instead of throwing on a malformed payload", () => {
    for (const bad of [
      null,
      undefined,
      "plugin.approval.requested",
      { event: "plugin.approval.requested" },
      { event: "plugin.approval.requested", payload: null },
      { event: "plugin.approval.requested", payload: { id: "x" } },
      { event: "plugin.approval.requested", payload: { id: 42, request: { toolCallId: "c" } } },
      { event: "plugin.approval.requested", payload: { id: "", request: { toolCallId: "c" } } },
      { event: "plugin.approval.requested", payload: { id: "x", request: { toolCallId: 7 } } },
    ]) {
      expect(() => readApprovalRequested(bad)).not.toThrow();
      expect(readApprovalRequested(bad)).toBeNull();
    }
  });
});
