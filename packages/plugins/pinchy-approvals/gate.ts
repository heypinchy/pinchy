// Pure decision logic for the pinchy-approvals before_tool_call gate. It asks
// Pinchy's gate-check endpoint (the authoritative policy + consume-once
// boundary) for every tool, and fails CLOSED if that service can't be reached
// — a gated, high-risk action must never slip through on an outage.

export interface GateConfig {
  apiBaseUrl: string;
  gatewayToken: string;
}

export interface GateContext {
  agentId?: string;
  sessionKey?: string;
  senderId?: string;
}

export interface GateResult {
  block?: boolean;
  blockReason?: string;
}

export type FetchLike = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string }
) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

function extractAgentId(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  return /^agent:([^:]+):/.exec(sessionKey)?.[1];
}

const UNAVAILABLE = "Tool blocked: the approval service is unavailable. Please try again shortly.";

export async function evaluateGate(
  toolName: string,
  params: Record<string, unknown>,
  ctx: GateContext,
  cfg: GateConfig,
  fetchImpl: FetchLike
): Promise<GateResult> {
  const agentId = ctx.agentId ?? extractAgentId(ctx.sessionKey);
  if (!agentId || !ctx.sessionKey) {
    // No identifiable agent/session — the per-agent confirmation policy cannot
    // apply, so there is nothing to gate.
    return {};
  }

  // One try around fetch AND body parsing: a malformed body (proxy error page,
  // truncated response) must land in the same fail-closed branch as a network
  // error — OpenClaw would block on a throwing hook anyway, but with a generic
  // hook-failure text instead of this actionable reason.
  let data: { decision?: string; reason?: string };
  try {
    const res = await fetchImpl(`${cfg.apiBaseUrl}/api/internal/approvals/gate-check`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${cfg.gatewayToken}`,
      },
      body: JSON.stringify({
        agentId,
        sessionKey: ctx.sessionKey,
        senderId: ctx.senderId,
        toolName,
        params,
      }),
    });
    if (!res.ok) {
      return { block: true, blockReason: UNAVAILABLE };
    }
    data = (await res.json()) as { decision?: string; reason?: string };
  } catch {
    return { block: true, blockReason: UNAVAILABLE };
  }
  if (data.decision === "block") {
    return {
      block: true,
      blockReason: data.reason ?? "Confirmation required before running this tool.",
    };
  }
  return {};
}
