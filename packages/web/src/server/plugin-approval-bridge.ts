import { linkApproval as linkApprovalDefault } from "@/lib/approvals/service";
import { readApprovalRequested } from "@/lib/approvals/broadcast";

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
  onError?: (err: unknown) => void;
}

/** Attaches the listener and returns its teardown. */
export function attachPluginApprovalBridge(
  client: GatewayEvents,
  deps: ApprovalBridgeDeps = {}
): () => void {
  const link = deps.link ?? linkApprovalDefault;
  const onError =
    deps.onError ??
    ((err: unknown) => console.error("[approvals] could not link an approval:", err));

  const listener = (frame: unknown) => {
    const approval = readApprovalRequested(frame);
    // Every gateway frame passes through here — session messages, deltas,
    // status. Returning before touching the database is what keeps this off
    // the hot path.
    if (!approval) return;

    // `emit` is synchronous, so a rejected promise escaping this listener is an
    // UNHANDLED rejection and takes the server process down. A database blip
    // during one approval must cost that approval, not the whole install.
    //
    // The whole `approval` goes through — including the session, when OpenClaw
    // named one — because a tool call id is not a key on its own (see
    // `sessionScope` in lib/approvals/service.ts).
    void link(approval)
      .then((linked) => {
        // `null` is the ordinary case, not a fault: the same broadcast carries
        // OpenClaw's own approvals (skill workshop, exec), which name calls
        // Pinchy never opened a confirmation for.
        void linked;
      })
      .catch(onError);
  };

  client.on("event", listener);
  return () => {
    client.off("event", listener);
  };
}
