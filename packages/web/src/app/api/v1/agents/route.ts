import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { withApiKey } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { createAgent, listAgents } from "@/lib/agents";
import { createAgentSchema } from "@/lib/schemas/agents";
import { appendAuditLog } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";

/**
 * List every non-deleted shared agent. Key-authenticated counterpart to the
 * session `GET /api/agents` — org-scoped rather than per-user, so unlike
 * `getVisibleAgents` it does not filter by the caller's group membership
 * (design D4). Personal agents are excluded: they are private to their owner,
 * and a key is a machine identity for the org, not for any human. That
 * exclusion lives in `listAgents({ scope: "shared" })` — there is no scope
 * that would return them. Read-only: no audit entry.
 *
 * Unpaginated, deliberately: a Pinchy org has tens of agents, not thousands,
 * and a cursor nobody needs is a contract we'd owe forever. The `{ agents }`
 * envelope is the hedge — `nextCursor` can join it later without breaking a
 * single client, which is why the response isn't a bare array.
 */
export const GET = withApiKey(["agents:read"], async () => {
  const agents = await listAgents({ scope: "shared" });
  return NextResponse.json({ agents });
});

/**
 * Create an agent from a template via an API key. Key-authenticated
 * counterpart to the session `POST /api/agents` — both wrap the same
 * auth-/audit-/HTTP-agnostic `createAgent()` service (#572) and map its
 * discriminated result onto identical response bodies. This route differs
 * only in auth (`withApiKey` instead of `withAdmin`) and audit actor: the KEY
 * is the actor (`actorType: "api_key"`, design D2), not a user.
 *
 * There is deliberately no "issuer" or delegation field in the detail. A key
 * belongs to the organization, not to the admin who created it
 * (lib/api-key-identity.ts) — so it acts for itself, and claiming otherwise
 * would attribute a machine's action to a person who may have left years ago
 * and had no part in it. The key's own `{ id, name }` snapshot is the
 * attribution, and it stays readable after the key is revoked. Who created
 * the key is recorded once, on the key.
 *
 * The agent it creates has `ownerId: null` for the same reason.
 */
export const POST = withApiKey(["agents:write"], async (req, _ctx, key) => {
  const parsed = await parseRequestBody(createAgentSchema, req);
  if ("error" in parsed) return parsed.error;

  // Both audits are registered the instant their rows exist — NOT after
  // createAgent returns. Everything it still has to do (workspace, OpenClaw
  // regen) can throw, and none of it rolls the committed writes back. after()
  // fires on response close even when the handler threw, so a 500 here yields
  // an agent and grants that exist AND are audited. Reading the return value
  // instead would lose both records precisely when something went wrong.
  const result = await createAgent(parsed.data, null, {
    onCreated: (agent, audit) =>
      after(() =>
        appendAuditLog({
          actorType: "api_key",
          actorId: key.keyId,
          eventType: "agent.created",
          resource: `agent:${agent.id}`,
          detail: {
            name: agent.name,
            model: agent.model,
            templateId: parsed.data.templateId,
            skills: audit.templateSkills,
            modelSelection: audit.modelSelection,
            apiKey: { id: key.keyId, name: key.name },
          },
          outcome: "success",
        })
      ),
    onPermissionsConfigured: (agent, entry) =>
      deferAuditLog({
        actorType: "api_key",
        actorId: key.keyId,
        eventType: "config.changed",
        resource: `agent:${agent.id}`,
        detail: {
          action: "agent_integration_permissions_auto_configured",
          agentId: agent.id,
          connectionId: entry.connectionId,
          permissions: entry.permissions,
          apiKey: { id: key.keyId, name: key.name },
        },
        outcome: "success",
      }),
  });

  if (!result.ok) {
    // Only the capability path (422) is audited — parity with the session
    // route (plain 400 validation failures were never logged there either).
    // Both return before the insert, so onCreated above never fired.
    if (result.error.status === 422) {
      await appendAuditLog({
        actorType: "api_key",
        actorId: key.keyId,
        eventType: "agent.created",
        outcome: "failure",
        detail: {
          ...result.error.capabilityFailure,
          apiKey: { id: key.keyId, name: key.name },
        },
      });
    }
    return NextResponse.json(result.error.body, { status: result.error.status });
  }

  const { agent, runtimeWarning, runtimeApplyError } = result;

  // The agent row is committed (audited success above) but never reached the
  // runtime (#880). Record a distinct failure event so the trail shows "created
  // but not applied" instead of implying a clean create — the key API owes the
  // same audit trail as the session route, with the KEY as actor. deferAuditLog:
  // the create already happened and must not be rolled back if this write fails.
  if (runtimeWarning) {
    deferAuditLog({
      actorType: "api_key",
      actorId: key.keyId,
      eventType: "config.changed",
      resource: `agent:${agent.id}`,
      detail: {
        action: "runtime_apply_failed",
        agentId: agent.id,
        name: agent.name,
        error: runtimeApplyError,
        apiKey: { id: key.keyId, name: key.name },
      },
      outcome: "failure",
    });
  }

  // A key-created agent must appear in the admin UI immediately, same as a
  // session-created one.
  revalidatePath("/", "layout");

  return NextResponse.json({ ...agent, warning: runtimeWarning }, { status: 201 });
});
