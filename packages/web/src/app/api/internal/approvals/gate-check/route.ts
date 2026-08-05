import { NextRequest, NextResponse } from "next/server";
import { eq, sql } from "drizzle-orm";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { gateCheckSchema } from "@/lib/schemas/approvals";
import { decideGate } from "@/lib/approvals/service";
import { computeArgsDigest } from "@/lib/approvals/digest";
import { summarizeArgs } from "@/lib/approvals/summary";
import { getConfirmTools } from "@/lib/approvals/policy";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { db } from "@/db";
import { agents, users } from "@/db/schema";

/**
 * The pinchy-approvals gate calls this for every tool it has decided is gated.
 * It is the server-side security boundary: it consumes a valid ticket (allow)
 * or records a pending confirmation (block). The acting user approves their
 * own request via the session-authed decision route.
 */
function deriveRequesterPrincipal(
  senderId: string | undefined,
  sessionKey: string | undefined
): string | undefined {
  if (senderId) return senderId;
  if (!sessionKey) return undefined;
  // Non-greedy: a userId never contains a colon, but a `:<chatId>` segment can
  // follow it. Mirrors extractUserIdFromSessionKey in the tool-use audit route —
  // a greedy `(.+)$` would swallow `<userId>:<chatId>` and mis-attribute.
  return /^agent:[^:]+:direct:([^:]+)/.exec(sessionKey)?.[1];
}

/**
 * OpenClaw normalizes session keys to lowercase, so the principal we read back
 * from `ctx.sessionKey` is `lower(user.id)` — it never equals the mixed-case
 * `session.user.id` the decision route and the inbox compare against. (Same
 * reason `audit_log` logs "no user found for actorId" and falls back to the raw
 * value.) Resolve it case-insensitively to the real, case-preserved user id so
 * requester and approver compare equal.
 */
async function resolveRequesterUserId(principal: string): Promise<string | undefined> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.id}) = ${principal.toLowerCase()}`)
    .limit(1);
  return row?.id;
}

export async function POST(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(gateCheckSchema, request);
  if ("error" in parsed) return parsed.error;
  const { agentId, sessionKey, senderId, toolName, params } = parsed.data;

  // Policy lives server-side: load the agent and short-circuit ungated tools
  // so the gate adds no pending row (and the plugin can safely call this for
  // every tool). One DB read keeps the policy always-fresh — no plugin cache.
  const [agent] = await db
    .select({ name: agents.name, pluginConfig: agents.pluginConfig })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  if (!agent || !getConfirmTools(agent.pluginConfig).includes(toolName)) {
    return NextResponse.json({ decision: "allow" });
  }

  const principal = deriveRequesterPrincipal(senderId, sessionKey);
  const requesterId = principal ? await resolveRequesterUserId(principal) : undefined;
  if (!requesterId || !sessionKey) {
    // Fail closed: a gated tool must not run for an unidentifiable user — only
    // a real Pinchy user can confirm it.
    //
    // A missing sessionKey lands here for the same reason and not by accident:
    // a grant is bound to one session, so without one there is nothing to bind
    // it to and no inbox the card would appear in. This is the branch the
    // plugin used to pre-empt by allowing the call outright.
    return NextResponse.json({
      decision: "block",
      reason:
        `This action needs a confirmation from the person who asked for it, ` +
        `but that person could not be identified in this conversation — so it was not run. ` +
        `This happens outside the Pinchy app, where nobody can confirm. ` +
        `Tell them that, then stop — do not call this tool again.`,
    });
  }

  const argsDigest = computeArgsDigest(params);
  const result = await decideGate({
    agentId,
    requesterId,
    sessionKey,
    toolName,
    argsDigest,
    argsSummary: summarizeArgs(params),
  });

  // Audit a fresh request once (not on retries) and every consume.
  if (result.created || result.decision === "allow") {
    const [requester] = await db
      .select({ name: users.name })
      .from(users)
      .where(eq(users.id, requesterId))
      .limit(1);
    const entry: AuditLogEntry = {
      actorType: "agent",
      actorId: agentId,
      eventType: result.decision === "allow" ? "approval.consumed" : "approval.requested",
      resource: `approval:${result.requestId}`,
      detail: {
        request: { id: result.requestId },
        agent: { id: agentId, name: agent?.name ?? null },
        requester: { id: requesterId, name: requester?.name ?? null },
        toolName,
        argsDigest,
      },
      outcome: "success",
    };
    try {
      await appendAuditLog(entry);
    } catch (err) {
      recordAuditFailure(err, entry);
    }
  }

  if (result.decision === "allow") {
    return NextResponse.json({ decision: "allow", requestId: result.requestId });
  }

  // Backpressure, not a confirmation request: nothing was opened, so there is
  // nothing to audit as `approval.requested` either (the block above already
  // skipped it — `created` is false). Say what is actually in the way, or the
  // user goes looking for a card that was never created.
  if (result.limited) {
    return NextResponse.json({
      decision: "block",
      requestId: result.requestId,
      reason:
        `This action was not run: the user already has the maximum number of ` +
        `confirmations waiting in Pinchy. Ask them to work through those first, ` +
        `then stop — do not call this tool again, and do not suggest any command.`,
    });
  }
  // This reason is consumed by the MODEL as the tool result, and the model
  // relays it to the person in the chat — so it is written for that relay, not
  // as an error string.
  //
  // It deliberately carries NO request id: `/approve <id>` is a real OpenClaw
  // command for OpenClaw's OWN approvals, and given an id the model helpfully
  // invents that command. Ours are Pinchy rows OpenClaw has never heard of, so
  // the user is handed an instruction that fails. The id still travels in the
  // response body, where the plugin — not the model — can read it.
  //
  // It also tells the model to stop rather than retry: without that, a model
  // that reads "confirmation required" often calls the tool again immediately
  // and burns the same block on a loop.
  return NextResponse.json({
    decision: "block",
    requestId: result.requestId,
    reason:
      `This action needs the user's confirmation before it can run. ` +
      `A confirmation card is waiting for them in Pinchy. ` +
      `Tell them what you are about to do and that you are waiting for their confirmation, ` +
      `then stop — do not call this tool again, and do not suggest any command.`,
  });
}
