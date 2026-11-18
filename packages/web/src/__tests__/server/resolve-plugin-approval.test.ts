import { describe, it, expect, vi } from "vitest";
import { resolvePluginApproval } from "@/server/resolve-plugin-approval";

/**
 * #1132, the half that actually restarts the run. `pinchy-approvals` answers a
 * gated call with `requireApproval`, so OpenClaw parks the call INSIDE the hook
 * awaiting `plugin.approval.waitDecision`. Flipping our row does nothing to
 * that; only `plugin.approval.resolve` does.
 */
function gateway(response: { ok: boolean; error?: { message?: string } } = { ok: true }) {
  const request = vi.fn().mockResolvedValue(response);
  return { request, getClient: () => ({ request }) };
}

describe("resolvePluginApproval", () => {
  it("lets the suspended call proceed when the user approves", async () => {
    const gw = gateway();

    const outcome = await resolvePluginApproval(
      { approvalId: "plugin:abc", decision: "approve" },
      { getClient: gw.getClient }
    );

    expect(gw.request).toHaveBeenCalledWith("plugin.approval.resolve", {
      id: "plugin:abc",
      decision: "allow-once",
    });
    expect(outcome).toEqual({ delivered: true });
  });

  // Deliberately not "allow-always": pinchy-approvals does not offer it, and
  // OpenClaw would not persist it for a generic hook anyway.
  it("denies the suspended call when the user denies", async () => {
    const gw = gateway();

    await resolvePluginApproval(
      { approvalId: "plugin:abc", decision: "deny" },
      { getClient: gw.getClient }
    );

    expect(gw.request).toHaveBeenCalledWith("plugin.approval.resolve", {
      id: "plugin:abc",
      decision: "deny",
    });
  });

  // openclaw-node RESOLVES on an error response rather than rejecting, so
  // awaiting alone reports a refused resolve as a successful one — the user
  // gets a green toast over a run that stays parked until it times out.
  it("reads the ok flag instead of trusting that the call returned", async () => {
    const gw = gateway({ ok: false, error: { message: "approval not found" } });

    const outcome = await resolvePluginApproval(
      { approvalId: "plugin:abc", decision: "approve" },
      { getClient: gw.getClient }
    );

    expect(outcome).toEqual({
      delivered: false,
      reason: "refused",
      detail: "approval not found",
    });
  });

  it("reports an unreachable gateway rather than throwing into the route", async () => {
    const getClient = () => ({ request: vi.fn().mockRejectedValue(new Error("socket hang up")) });

    const outcome = await resolvePluginApproval(
      { approvalId: "plugin:abc", decision: "approve" },
      { getClient }
    );

    expect(outcome).toEqual({
      delivered: false,
      reason: "unreachable",
      detail: "socket hang up",
    });
  });

  // getOpenClawClient() throws when nothing has connected yet. That is the same
  // situation as an unreachable gateway from the user's side, and it must not
  // become a 500 on a decision that IS persisted.
  it("treats a missing client as an unreachable gateway", async () => {
    const getClient = () => {
      throw new Error("OpenClaw client not initialized");
    };

    const outcome = await resolvePluginApproval(
      { approvalId: "plugin:abc", decision: "approve" },
      { getClient }
    );

    expect(outcome).toMatchObject({ delivered: false, reason: "unreachable" });
  });

  // A pending row without an id means nothing is waiting on us: the gate
  // refused without suspending (unattributable caller, pending cap), the
  // approval already timed out, or the row predates #1132. There is no run to
  // resume — and saying so is the point, because the user who just clicked
  // "approve" would otherwise believe the tool ran.
  it("does not call the gateway when no approval is waiting", async () => {
    const gw = gateway();

    const outcome = await resolvePluginApproval(
      { approvalId: null, decision: "approve" },
      { getClient: gw.getClient }
    );

    expect(gw.request).not.toHaveBeenCalled();
    expect(outcome).toEqual({ delivered: false, reason: "nothing-waiting" });
  });
});
