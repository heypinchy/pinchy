import { describe, it, expect, vi, afterEach } from "vitest";
import { evaluateGate } from "./gate";

const cfg = { apiBaseUrl: "http://pinchy:7777", gatewayToken: "tok" };
const ctx = { sessionKey: "agent:a1:direct:u1" };

/** Stub the global fetch the gate calls, and hand the mock back for assertions. */
function stubFetch(impl: () => unknown) {
  const f = vi.fn().mockImplementation(impl);
  vi.stubGlobal("fetch", f);
  return f;
}

function stubDecision(decision: string, reason?: string) {
  return stubFetch(() => Promise.resolve({ ok: true, json: async () => ({ decision, reason }) }));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("evaluateGate", () => {
  it("allows when the route returns allow", async () => {
    stubDecision("allow");
    expect(await evaluateGate("odoo_write", {}, ctx, cfg)).toEqual({});
  });

  it("blocks with the route's reason", async () => {
    stubDecision("block", "Approve to proceed");
    const res = await evaluateGate("odoo_write", {}, ctx, cfg);
    expect(res).toEqual({ block: true, blockReason: "Approve to proceed" });
  });

  it("pauses the run instead of blocking when the server sends prompt text", async () => {
    // #1132. `block: true` is terminal: the run continues, the model receives
    // the reason as the tool result and narrates it — so the agent answers
    // before the person has decided, and approving does nothing on its own.
    // `requireApproval` is the one return value that actually suspends the
    // call until someone resolves it.
    stubFetch(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          decision: "block",
          requestId: "req-1",
          reason: "model-facing text",
          approval: { title: "Update a record", description: "Odoo: write — recordId: 5" },
        }),
      })
    );

    const res = await evaluateGate("odoo_write", { recordId: 5 }, ctx, cfg);

    expect(res.block).toBeUndefined();
    expect(res.requireApproval?.title).toBe("Update a record");
    expect(res.requireApproval?.description).toBe("Odoo: write — recordId: 5");
  });

  it("offers only allow-once and deny, never allow-always", async () => {
    // "Always allow" here would let a member permanently opt out of a policy
    // an admin set — a more specific level may be stricter than the one above
    // it, never looser. OpenClaw also does not persist allow-always for a
    // generic hook, so the button would promise durability we do not deliver.
    stubFetch(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          decision: "block",
          approval: { title: "t", description: "d" },
        }),
      })
    );

    const res = await evaluateGate("odoo_write", {}, ctx, cfg);
    expect(res.requireApproval?.allowedDecisions).toEqual(["allow-once", "deny"]);
  });

  it("denies on timeout rather than letting the action through", async () => {
    stubFetch(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          decision: "block",
          approval: { title: "t", description: "d" },
        }),
      })
    );

    const res = await evaluateGate("odoo_write", {}, ctx, cfg);
    expect(res.requireApproval?.timeoutBehavior).toBe("deny");
    // OpenClaw clamps anything above 600s, so asking for more would silently
    // become 600s and leave our own row outliving the approval it belongs to.
    expect(res.requireApproval?.timeoutMs).toBeLessThanOrEqual(600_000);
  });

  it("still blocks outright when there is nothing for anyone to confirm", async () => {
    // No prompt text means the server refused for a reason no card can fix —
    // an unattributable caller, or the pending-confirmation cap. Pausing the
    // run there would hang it on an approval that is never going to appear.
    stubDecision("block", "Nobody can confirm this here.");
    const res = await evaluateGate("odoo_write", {}, ctx, cfg);
    expect(res).toEqual({ block: true, blockReason: "Nobody can confirm this here." });
  });

  it("fails closed when the approval service is unreachable", async () => {
    stubFetch(() => Promise.reject(new Error("ECONNREFUSED")));
    const res = await evaluateGate("odoo_write", {}, ctx, cfg);
    expect(res.block).toBe(true);
    expect(res.blockReason).toMatch(/unavailable/i);
  });

  it("fails closed (with the unavailable reason) when the response body is not valid JSON", async () => {
    // OpenClaw 2026.7.1 blocks on a throwing hook anyway, but then the user
    // sees the generic hook-failure text instead of our actionable message.
    stubFetch(() =>
      Promise.resolve({
        ok: true,
        json: async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        },
      })
    );
    const res = await evaluateGate("odoo_write", {}, ctx, cfg);
    expect(res.block).toBe(true);
    expect(res.blockReason).toMatch(/unavailable/i);
  });

  it("fails closed on a non-2xx response", async () => {
    stubFetch(() => Promise.resolve({ ok: false, json: async () => ({}) }));
    expect((await evaluateGate("odoo_write", {}, ctx, cfg)).block).toBe(true);
  });

  it("sends the derived agentId, tool name, and params", async () => {
    const f = stubDecision("allow");
    await evaluateGate("odoo_write", { recordId: 7 }, ctx, cfg);
    const body = JSON.parse(f.mock.calls[0][1].body);
    expect(body).toMatchObject({ agentId: "a1", toolName: "odoo_write", params: { recordId: 7 } });
  });

  // This hook runs before EVERY tool call of EVERY agent, so an unbounded fetch
  // has no failure mode that looks like a bug: the call simply never returns,
  // and a Pinchy container mid-deploy — or a blackhole that swallows packets
  // without an RST — stalls the whole install with nothing in any log naming
  // the cause. Exactly what AGENTS.md §"Every plugin fetch() passes a signal"
  // exists to prevent; the gate escaped that guard for as long as it reached
  // fetch through an injected parameter, which the scan cannot follow.
  it("bounds the gate-check request with an abort signal", async () => {
    const f = stubDecision("allow");
    await evaluateGate("odoo_write", {}, ctx, cfg);
    expect(f.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it("does not gate (and does not call the API) without an identifiable agent", async () => {
    const f = stubDecision("block");
    expect(await evaluateGate("odoo_write", {}, {}, cfg)).toEqual({});
    expect(f).not.toHaveBeenCalled();
  });

  // A missing session key is NOT "nothing to gate". The agent and the tool are
  // both known, so the admin's policy applies in full — what is missing is the
  // person who would confirm, and that is the server's call to make (it already
  // refuses a request it cannot attribute). Deciding it here meant any run
  // context OpenClaw hands us without a session key — a cron run, a subagent —
  // silently executed every tool an admin had gated.
  it("asks the server even when the run carries no session key", async () => {
    const f = stubDecision("block", "Nobody can confirm this here.");
    const res = await evaluateGate("odoo_write", {}, { agentId: "a1" }, cfg);
    expect(res).toEqual({ block: true, blockReason: "Nobody can confirm this here." });
    expect(f).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.mock.calls[0][1].body)).toMatchObject({ agentId: "a1" });
  });
});

/**
 * #1132. The decision route covers the button the user clicks. It does NOT
 * cover the outcomes nobody clicks — a timeout, a cancelled run — and it does
 * not know whether OpenClaw really acted on the answer. `onResolution` is the
 * runtime telling us what it did, which is the only trustworthy source for
 * "the grant was spent".
 */
describe("onResolution", () => {
  function stubApprovalRequired() {
    return stubFetch(() =>
      Promise.resolve({
        ok: true,
        json: async () => ({
          decision: "block",
          approval: { title: "t", description: "d" },
        }),
      })
    );
  }

  const withCall = { ...ctx, toolCallId: "call_7" };

  it("reports what OpenClaw actually did with the parked call", async () => {
    const f = stubApprovalRequired();
    const res = await evaluateGate("odoo_write", {}, withCall, cfg);

    await res.requireApproval?.onResolution?.("allow-once");

    const [url, init] = f.mock.calls[1];
    expect(url).toBe("http://pinchy:7777/api/internal/approvals/resolution");
    expect(JSON.parse(init.body)).toEqual({ toolCallId: "call_7", decision: "allow-once" });
  });

  it("reports a timeout, which no button ever produces", async () => {
    const f = stubApprovalRequired();
    const res = await evaluateGate("odoo_write", {}, withCall, cfg);

    await res.requireApproval?.onResolution?.("timeout");

    expect(JSON.parse(f.mock.calls[1][1].body).decision).toBe("timeout");
  });

  // OpenClaw calls this callback while finalizing the approval and only logs a
  // rejection. Throwing here buys nothing and risks noise on a path where the
  // decision has already taken effect.
  it("swallows a failed report instead of throwing into the runtime", async () => {
    const f = stubApprovalRequired();
    const gated = await evaluateGate("odoo_write", {}, withCall, cfg);
    f.mockRejectedValueOnce(new Error("connection refused"));

    await expect(gated.requireApproval?.onResolution?.("allow-once")).resolves.toBeUndefined();
  });

  // Without a call id there is no row to attribute the outcome to, and posting
  // one would make the endpoint guess.
  it("does not report when the call cannot be identified", async () => {
    const f = stubApprovalRequired();
    const res = await evaluateGate("odoo_write", {}, ctx, cfg);

    await res.requireApproval?.onResolution?.("allow-once");

    expect(f).toHaveBeenCalledTimes(1);
  });
});
