import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { decisionSchema } from "@/lib/schemas/approvals";
import { resolveDecision } from "@/lib/approvals/service";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { db } from "@/db";
import { agents, users } from "@/db/schema";

type RouteContext = { params: Promise<{ id: string }> };

/**
 * The acting user approves or denies their own pending confirmation (Tier 2
 * self-confirm — enforced by `selfConfirmOnly`). On approve, the request
 * becomes consumable; the agent re-issues the call and the gate consumes it.
 */
export const POST = withAuth<RouteContext>(async (request, { params }, session) => {
  const { id } = await params;

  const parsed = await parseRequestBody(decisionSchema, request);
  if ("error" in parsed) return parsed.error;
  const { decision, reason } = parsed.data;

  const res = await resolveDecision({
    id,
    approverId: session.user.id!,
    decision,
    reason,
    selfConfirmOnly: true,
  });
  if (!res.ok) {
    const status = res.reason === "not_found" ? 404 : res.reason === "forbidden" ? 403 : 409;
    return NextResponse.json({ error: res.reason }, { status });
  }
  const req = res.request;

  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, req.agentId))
    .limit(1);
  const [requester] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, req.requesterId))
    .limit(1);

  const entry: AuditLogEntry = {
    actorType: "user",
    actorId: session.user.id!,
    eventType: decision === "approve" ? "approval.granted" : "approval.denied",
    resource: `approval:${id}`,
    detail: {
      request: { id },
      agent: { id: req.agentId, name: agent?.name ?? null },
      requester: { id: req.requesterId, name: requester?.name ?? null },
      approver: { id: session.user.id!, name: session.user.name ?? null },
      toolName: req.toolName,
      argsDigest: req.argsDigest,
      ...(reason ? { reason } : {}),
    },
    outcome: "success",
  };
  try {
    await appendAuditLog(entry);
  } catch {
    return NextResponse.json({ error: "Audit logging failed" }, { status: 500 });
  }

  // On approve, Phase E2 injects a "proceed" turn into req.sessionKey so the
  // agent re-issues the call and the gate consumes the now-approved ticket.

  return NextResponse.json({ ok: true, status: req.status });
});
