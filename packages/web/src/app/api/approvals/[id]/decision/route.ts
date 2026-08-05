import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { decisionSchema } from "@/lib/schemas/approvals";
import { resolveDecision } from "@/lib/approvals/service";
import { resolvePluginApproval } from "@/server/resolve-plugin-approval";
import { type AuditLogEntry } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { db } from "@/db";
import { agents, users } from "@/db/schema";

type RouteContext = { params: Promise<{ id: string }> };

/** What to tell the user when their decision did not reach the parked run.
 * Worded for approve and deny alike: in both cases the agent was not told. */
const NOT_DELIVERED: Record<"nothing-waiting" | "refused" | "unreachable", string> = {
  "nothing-waiting":
    "The agent is no longer waiting for this decision. Ask it to try the action again.",
  refused: "OpenClaw would not accept this decision, so the agent has not been told.",
  unreachable: "Pinchy could not reach OpenClaw, so the agent has not been told.",
};

/**
 * The acting user approves or denies their own pending confirmation (Tier 2
 * self-confirm — enforced by `selfConfirmOnly`).
 *
 * Two things have to happen, in this order. The row is flipped first, so a
 * failure between them leaves a decision on record and a tool that did NOT run
 * — the safe direction. Then the decision is handed to the call OpenClaw parked
 * for it: `pinchy-approvals` answers with `requireApproval`, which suspends the
 * call inside OpenClaw's hook, and only `plugin.approval.resolve` ends that
 * wait. Flipping the row alone leaves the run parked until its 600 s cap.
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

  const resumed = await resolvePluginApproval({
    approvalId: req.openclawApprovalId,
    decision,
  });

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
      // A decision the parked run never received changed nothing the user can
      // see, so the row has to say which of the two happened.
      resumed: resumed.delivered,
      ...(resumed.delivered
        ? {}
        : {
            resumeReason: resumed.reason,
            ...(resumed.detail ? { resumeDetail: resumed.detail } : {}),
          }),
    },
    outcome: resumed.delivered ? "success" : "failure",
  };
  // Deferred, not awaited: the decision above is already persisted and not
  // rollbackable, so a 500 here would only mislead (a retry then 409s with
  // not_pending). deferAuditLog records a write failure as a structured
  // signal instead (AGENTS.md §"Audit logging rules").
  deferAuditLog(entry);

  // 200 even when the resume failed: the decision itself IS persisted, so a
  // retry would only 409 `not_pending`. `resumed: false` is what the UI turns
  // into a warning — reporting a bare `ok` here is exactly the false success
  // this route exists to avoid.
  return NextResponse.json({
    ok: true,
    status: req.status,
    resumed: resumed.delivered,
    ...(resumed.delivered ? {} : { resumeError: NOT_DELIVERED[resumed.reason] }),
  });
});
