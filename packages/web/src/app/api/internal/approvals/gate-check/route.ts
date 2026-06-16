import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
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
function deriveRequesterId(senderId: string | undefined, sessionKey: string): string | undefined {
  if (senderId) return senderId;
  return /^agent:[^:]+:direct:(.+)$/.exec(sessionKey)?.[1];
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

  const requesterId = deriveRequesterId(senderId, sessionKey);
  if (!requesterId) {
    // Fail closed: a gated tool must not run for an unidentifiable user.
    return NextResponse.json({
      decision: "block",
      reason: `Confirmation required for "${toolName}", but the requesting user could not be identified.`,
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
  return NextResponse.json({
    decision: "block",
    requestId: result.requestId,
    reason: `Confirmation required: approve running "${toolName}" in the chat to proceed (request ${result.requestId}).`,
  });
}
