import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { resolutionSchema } from "@/lib/schemas/approvals";
import { recordResolution } from "@/lib/approvals/service";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { db } from "@/db";
import { agents, users } from "@/db/schema";

/**
 * The gate's `onResolution` callback reports what OpenClaw finally did with a
 * call it had parked (#1132).
 *
 * This is not a second decision endpoint. It is the runtime's account of the
 * outcome, and it is the only channel for two things the decision route cannot
 * carry:
 *
 *  - the resolutions nobody clicks — the run stopped waiting, or was cancelled
 *    — which would otherwise leave a row `pending` and a card in an inbox over
 *    a call that is already gone;
 *  - the spent grant. An approved call resumes inside OpenClaw's hook and never
 *    passes the gate again, so no later consume step exists to record it.
 *
 * A resolution that settles nothing is the ordinary case, not a fault: the same
 * approval machinery carries OpenClaw's own requests (skill workshop, exec),
 * and those name calls Pinchy never opened a confirmation for.
 */
const EVENT_BY_STATUS = {
  consumed: "approval.consumed",
  denied: "approval.denied",
  expired: "approval.expired",
} as const;

export async function POST(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(resolutionSchema, request);
  if ("error" in parsed) return parsed.error;
  const { toolCallId, decision } = parsed.data;

  const settled = await recordResolution({ toolCallId, decision });
  // Nothing was waiting, or the user's own decision got there first — which
  // already wrote its audit row. A second one would double-count the same act.
  if (!settled) return NextResponse.json({ ok: true, settled: false });

  const [agent] = await db
    .select({ name: agents.name })
    .from(agents)
    .where(eq(agents.id, settled.agentId))
    .limit(1);
  const [requester] = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.id, settled.requesterId))
    .limit(1);

  const entry: AuditLogEntry = {
    // The agent's runtime is what resolved this, not a person and not a sweep.
    actorType: "agent",
    actorId: settled.agentId,
    eventType: EVENT_BY_STATUS[settled.status],
    resource: `approval:${settled.id}`,
    detail: {
      request: { id: settled.id },
      agent: { id: settled.agentId, name: agent?.name ?? null },
      requester: { id: settled.requesterId, name: requester?.name ?? null },
      toolName: settled.toolName,
      argsDigest: settled.argsDigest,
      // Which of the five outcomes this was. `approval.expired` is also written
      // by the hourly sweep with a `sweepId`; this field is what tells the two
      // apart — a run that stopped waiting, versus bookkeeping after the fact.
      resolution: decision,
    },
    outcome: "success",
  };
  // Awaited, not deferred: nothing here is a non-rollbackable side effect the
  // caller has already paid for, and the gate treats a failure as a failure to
  // report rather than as a failed resolution.
  try {
    await appendAuditLog(entry);
  } catch (err) {
    recordAuditFailure(err, entry);
  }

  return NextResponse.json({ ok: true, settled: true, status: settled.status });
}
