import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { createAgent } from "@/lib/agents";
import { createAgentSchema } from "@/lib/schemas/agents";
import { appendAuditLog } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { getVisibleAgents } from "@/lib/visible-agents";

export const GET = withAuth(async (_req, _ctx, session) => {
  const visibleAgents = await getVisibleAgents(session.user.id!, session.user.role ?? "member");
  // Short private cache absorbs back-and-forth agent-switch navigation
  // without re-querying on every mount; the list is per-user (private) and
  // 5 s keeps it fresh for operational changes (#261).
  return NextResponse.json(visibleAgents, {
    headers: { "Cache-Control": "private, max-age=5, must-revalidate" },
  });
});

export const POST = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(createAgentSchema, request);
  if ("error" in parsed) return parsed.error;

  // The domain work lives in the auth-/audit-/HTTP-agnostic createAgent()
  // service (#572) so the key-authenticated POST /api/v1/agents route can
  // reuse it. This route owns auth (withAdmin), audit (actorType: "user"),
  // and HTTP — mapping the service's discriminated result onto responses.
  const result = await createAgent(parsed.data, session.user.id!, (agent, audit) =>
    // Registered the instant the row exists — NOT after createAgent returns.
    // Everything it still has to do (permissions, workspace, OpenClaw regen)
    // can throw, and none of it rolls the insert back. after() fires on
    // response close even when the handler threw, so a 500 here yields an
    // agent that exists AND is audited. Waiting for the return value would
    // instead lose the record precisely when something went wrong.
    after(() =>
      appendAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "agent.created",
        resource: `agent:${agent.id}`,
        detail: {
          name: agent.name,
          model: agent.model,
          templateId: parsed.data.templateId,
          skills: audit.templateSkills,
          modelSelection: audit.modelSelection,
        },
        outcome: "success",
      })
    )
  );

  if (!result.ok) {
    // Only the capability path (422) is audited (parity with the pre-extraction
    // route). Plain 400 validation failures were never logged. Keying off the
    // status discriminant also narrows `error` to the arm carrying
    // `capabilityFailure`. Both return before the insert, so the callback
    // above never fired.
    if (result.error.status === 422) {
      await appendAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "agent.created",
        outcome: "failure",
        detail: result.error.capabilityFailure,
      });
    }
    return NextResponse.json(result.error.body, { status: result.error.status });
  }

  const { agent, autoConfiguredPermissions, runtimeWarning, runtimeApplyError } = result;

  for (const entry of autoConfiguredPermissions) {
    deferAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      resource: `agent:${agent.id}`,
      detail: {
        action: "agent_integration_permissions_auto_configured",
        agentId: agent.id,
        connectionId: entry.connectionId,
        permissions: entry.permissions,
      },
      outcome: "success",
    });
  }

  // The agent row is committed (audited success above) but never reached the
  // runtime (#880). Record a distinct failure event so the trail shows "created
  // but not applied" instead of implying a clean create. deferAuditLog: the
  // create already happened and must not be rolled back if this write fails.
  if (runtimeWarning) {
    deferAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      resource: `agent:${agent.id}`,
      detail: {
        action: "runtime_apply_failed",
        agentId: agent.id,
        name: agent.name,
        error: runtimeApplyError,
      },
      outcome: "failure",
    });
  }

  revalidatePath("/", "layout");

  return NextResponse.json({ ...agent, warning: runtimeWarning }, { status: 201 });
});
