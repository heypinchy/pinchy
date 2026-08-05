// Decision logic for the pinchy-approvals before_tool_call gate. It asks
// Pinchy's gate-check endpoint (the authoritative policy + consume-once
// boundary) for every tool, and fails CLOSED if that service can't be reached
// — a gated, high-risk action must never slip through on an outage.
//
// It calls the global `fetch` directly and is stubbed with `vi.stubGlobal` in
// tests, like every other plugin here. That is not a style preference: the
// timeout guard (packages/web/src/__tests__/lib/plugin-fetch-timeout-coverage)
// resolves `fetch` and its aliases, and CANNOT follow one handed in as a
// parameter — so an injected fetch is a call site no guard is looking at. This
// one was exactly that, and shipped unbounded.

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

function extractAgentId(sessionKey: string | undefined): string | undefined {
  if (!sessionKey) return undefined;
  return /^agent:([^:]+):/.exec(sessionKey)?.[1];
}

const UNAVAILABLE = "Tool blocked: the approval service is unavailable. Please try again shortly.";

// Pinchy sits on the same Docker network, so a healthy gate-check answers in
// milliseconds; this bound exists to make a blackhole terminate, not to enforce
// a latency budget. Same value as pinchy-audit's internal calls.
const FETCH_TIMEOUT_MS = 10_000;

export async function evaluateGate(
  toolName: string,
  params: Record<string, unknown>,
  ctx: GateContext,
  cfg: GateConfig
): Promise<GateResult> {
  const agentId = ctx.agentId ?? extractAgentId(ctx.sessionKey);
  if (!agentId) {
    // Nothing identifies the agent, so no per-agent policy exists to apply and
    // there is nothing to ask about.
    //
    // A MISSING SESSION KEY is a different question and deliberately NOT
    // answered here: the agent and the tool are both known, so the admin's
    // policy applies in full and only the confirming person is missing. That is
    // the server's call — it refuses a request it cannot attribute. Deciding it
    // here (as this used to, by allowing) meant every run context OpenClaw
    // hands over without a session key ran gated tools unchecked.
    return {};
  }

  // One try around fetch AND body parsing: a malformed body (proxy error page,
  // truncated response) must land in the same fail-closed branch as a network
  // error — OpenClaw would block on a throwing hook anyway, but with a generic
  // hook-failure text instead of this actionable reason.
  let data: { decision?: string; reason?: string };
  try {
    const res = await fetch(`${cfg.apiBaseUrl}/api/internal/approvals/gate-check`, {
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
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
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
