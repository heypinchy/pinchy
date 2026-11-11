import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { createAgent } from "@/lib/agents";
import { createAgentSchema } from "@/lib/schemas/agents";
import { appendAuditLog } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import {
  incompletePermissionsDetail,
  incompletePermissionsWarning,
} from "@/lib/agent-permission-gaps";
import { getVisibleAgents } from "@/lib/visible-agents";
import { queueFirstIndex } from "@/lib/knowledge/first-index";

export const GET = withAuth(async (_req, _ctx, session) => {
  const visibleAgents = await getVisibleAgents(session.user.id!, session.user.role ?? "member");
  // Never cached. The browser keys its cache by URL, not by user, so a short
  // private cache served one user's list to the next person signing in on
  // the same browser (#1286). It no longer bought anything either: the list
  // lives in AgentsProvider's client state, so navigation does not refetch
  // (#261's reason for the cache), and the poll/focus/refresh fetches that
  // remain want fresh data.
  return NextResponse.json(visibleAgents, {
    headers: { "Cache-Control": "no-store" },
  });
});

export const POST = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(createAgentSchema, request);
  if ("error" in parsed) return parsed.error;

  // The domain work lives in the auth-/audit-/HTTP-agnostic createAgent()
  // service (#572) so the key-authenticated POST /api/v1/agents route can
  // reuse it. This route owns auth (withAdmin), audit (actorType: "user"),
  // and HTTP — mapping the service's discriminated result onto responses.
  //
  // Both audits are registered the instant their rows exist — NOT after
  // createAgent returns. Everything it still has to do (workspace, OpenClaw
  // regen) can throw, and none of it rolls the committed writes back. after()
  // fires on response close even when the handler threw, so a 500 here yields
  // an agent and grants that exist AND are audited. Reading the return value
  // instead would lose both records precisely when something went wrong.
  const result = await createAgent(parsed.data, session.user.id!, {
    onCreated: (agent, audit) =>
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
      ),
    onPermissionsConfigured: (agent, entry) =>
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
      }),
    // #1208: what the connection could not grant used to be computed and
    // discarded, so an agent came out unable to do part of what its template
    // describes with nothing said anywhere. `failure` is the honest outcome —
    // the agent exists, the capability does not. The detail is built by the
    // shared helper so this route and the key-authenticated one cannot drift.
    onPermissionsIncomplete: (agent, entry) =>
      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        resource: `agent:${agent.id}`,
        detail: incompletePermissionsDetail(agent, entry),
        outcome: "failure",
      }),
  });

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

  const { agent, runtimeWarning, runtimeApplyError, incompletePermissions } = result;

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

  // A Knowledge Base agent finds nothing until its folders are indexed, and an
  // admin who creates one and asks it something straight away would take the
  // "nothing found" for a broken agent (#1280). So the first index is queued
  // here, as this admin's request. When another run holds the instance's one
  // job slot it is not queued now; the index worker queues it the moment the
  // slot frees. Never a reason to fail the create: the agent exists, and the
  // worker's next look catches what this could not do.
  try {
    await queueFirstIndex(agent.id, { actorType: "user", actorId: session.user.id! }, (entry) =>
      deferAuditLog(entry)
    );
  } catch (err) {
    console.error(`[agents] could not queue the first index of agent ${agent.id}:`, err);
  }

  revalidatePath("/", "layout");

  // One `warning` field, every reason a 201 is not a clean create. The audit
  // row above is the durable record; this is what reaches the admin who is
  // standing right there — the form raises it as a toast. Absent when nothing
  // went wrong, so its presence stays the whole check.
  const warning =
    [runtimeWarning, incompletePermissionsWarning(incompletePermissions)]
      .filter(Boolean)
      .join(" ") || undefined;

  return NextResponse.json({ ...agent, warning }, { status: 201 });
});
