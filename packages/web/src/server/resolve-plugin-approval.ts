import { getOpenClawClient } from "@/server/openclaw-client";

/**
 * Hand the user's decision to the call OpenClaw parked for it (#1132).
 *
 * `pinchy-approvals` answers a gated call with `requireApproval`, which parks
 * the call INSIDE OpenClaw's `before_tool_call` hook awaiting
 * `plugin.approval.waitDecision`. Flipping our own row does nothing to that
 * wait — this RPC is the only thing that ends it. Without it the run sits until
 * OpenClaw's 600 s cap expires and then reports a timeout, whatever the user
 * clicked.
 */
const RESOLVE_METHOD = "plugin.approval.resolve";

/** OpenClaw's decision vocabulary. `allow-always` is deliberately absent —
 * pinchy-approvals never offers it, because OpenClaw does not persist it for a
 * generic hook and a member must not be able to opt out of an admin's policy. */
const OPENCLAW_DECISION = { approve: "allow-once", deny: "deny" } as const;

export type ResolveOutcome =
  | { delivered: true }
  | {
      delivered: false;
      /**
       * `nothing-waiting` — no approval id on the row, so no parked call.
       * `refused` — the gateway answered, and said no.
       * `unreachable` — we could not ask.
       */
      reason: "nothing-waiting" | "refused" | "unreachable";
      detail?: string;
    };

interface GatewayRequest {
  request(
    method: string,
    params?: Record<string, unknown>
  ): Promise<{ ok: boolean; error?: { message?: string } }>;
}

export interface ResolveDeps {
  getClient?: () => GatewayRequest;
}

export async function resolvePluginApproval(
  input: { approvalId: string | null; decision: "approve" | "deny" },
  deps: ResolveDeps = {}
): Promise<ResolveOutcome> {
  if (!input.approvalId) return { delivered: false, reason: "nothing-waiting" };

  const getClient = deps.getClient ?? getOpenClawClient;

  try {
    // getOpenClawClient() throws when nothing has connected yet, which is the
    // same thing as an unreachable gateway from where the user is standing —
    // so it belongs inside this try rather than becoming a 500 on a decision
    // that is already persisted.
    const client = getClient();
    const response = await client.request(RESOLVE_METHOD, {
      id: input.approvalId,
      decision: OPENCLAW_DECISION[input.decision],
    });
    // openclaw-node RESOLVES on an error response rather than rejecting, so the
    // `ok` flag has to be read: awaiting alone would report a refused resolve as
    // a delivered one — a green toast over a run that stays parked.
    if (!response.ok) {
      return { delivered: false, reason: "refused", detail: response.error?.message };
    }
    return { delivered: true };
  } catch (err) {
    return {
      delivered: false,
      reason: "unreachable",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}
