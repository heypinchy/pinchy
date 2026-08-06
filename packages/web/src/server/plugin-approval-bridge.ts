import { linkApproval as linkApprovalDefault } from "@/lib/approvals/service";
import { readApprovalRequested } from "@/lib/approvals/broadcast";
import { resolvePluginApproval as resolvePluginApprovalDefault } from "@/server/resolve-plugin-approval";

/**
 * The receiving half of a native confirmation (#1132).
 *
 * `pinchy-approvals` answers a gated call with `requireApproval`, which makes
 * OpenClaw SUSPEND the call and announce it on the gateway. Pinchy's connection
 * carries `operator.admin`, so it is one of the approval routes OpenClaw will
 * deliver to — no registration, being connected with that scope is what makes
 * it one. This listener hears the announcement and records OpenClaw's id on the
 * confirmation that is waiting for that call, which is what later lets the
 * user's decision resume the run.
 *
 * Without it the run stays parked until it times out, whatever the user clicks.
 *
 * Attached once per process to the shared client, next to the other gateway
 * listeners in `server.ts`.
 */

/** Anything that emits gateway frames — the real `OpenClawClient`, or a plain
 * emitter in tests. Narrow on purpose: the bridge needs nothing else. */
export interface GatewayEvents {
  on(event: "event", listener: (payload: unknown) => void): unknown;
  off(event: "event", listener: (payload: unknown) => void): unknown;
}

export interface ApprovalBridgeDeps {
  link?: typeof linkApprovalDefault;
  resolve?: typeof resolvePluginApprovalDefault;
  onError?: (err: unknown) => void;
  /** Called when the approval was ours but arrived too late to link. Separate
   * from `onError` because it is not a fault in Pinchy — it is a fact about
   * timing that is worth seeing rather than swallowing. */
  onLate?: (info: { toolCallId: string; approvalId: string }) => void;
}

/** Attaches the listener and returns its teardown. */
export function attachPluginApprovalBridge(
  client: GatewayEvents,
  deps: ApprovalBridgeDeps = {}
): () => void {
  const link = deps.link ?? linkApprovalDefault;
  const resolve = deps.resolve ?? resolvePluginApprovalDefault;
  const onError =
    deps.onError ??
    ((err: unknown) => console.error("[approvals] could not link an approval:", err));
  const onLate =
    deps.onLate ??
    ((info: { toolCallId: string; approvalId: string }) =>
      console.warn(
        `[approvals] approval ${info.approvalId} for call ${info.toolCallId} arrived after the confirmation was already settled — the run was not resumed`
      ));

  const listener = (frame: unknown) => {
    const approval = readApprovalRequested(frame);
    // Every gateway frame passes through here — session messages, deltas,
    // status. Returning before touching the database is what keeps this off
    // the hot path.
    if (!approval) return;

    // `emit` is synchronous, so a rejected promise escaping this listener is an
    // UNHANDLED rejection and takes the server process down. A database blip
    // during one approval must cost that approval, not the whole install.
    void link(approval)
      .then(async (outcome) => {
        if (!outcome.linked) {
          // "not-ours" is the ordinary case, not a fault: the same broadcast
          // carries OpenClaw's own approvals (skill workshop, exec), which name
          // calls Pinchy never opened a confirmation for. "settled" is ours and
          // worth saying out loud — see `onLate`.
          if (outcome.reason === "settled") onLate(approval);
          return;
        }
        if (outcome.status === "pending") return;

        // The user decided before OpenClaw announced the approval. Their
        // decision reached the row but not the parked call — the decision route
        // had no id to resolve with. The broadcast is what delivers it, however
        // late it is: this is the only path that can, because the route has
        // already answered and will not run again.
        //
        // Deliberately event-driven rather than making the route WAIT some
        // guessed number of seconds for this broadcast. A wait would be a
        // timing assumption dressed up as a fix, and it would still lose
        // whenever the guess was too short.
        //
        // The cost, stated plainly: the user was already told the decision did
        // not reach the run, and that message is now pessimistic rather than
        // wrong-in-their-favour. The run continues, and `onResolution` records
        // what the runtime actually did, so the audit trail ends up correct.
        await resolve({
          approvalId: approval.approvalId,
          decision: outcome.status === "approved" ? "approve" : "deny",
        });
      })
      .catch(onError);
  };

  client.on("event", listener);
  return () => {
    client.off("event", listener);
  };
}
