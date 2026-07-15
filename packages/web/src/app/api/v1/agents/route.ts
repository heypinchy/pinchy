import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { withApiKey } from "@/lib/api-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { createAgent, listAgents } from "@/lib/agents";
import { createAgentSchema } from "@/lib/schemas/agents";
import { appendAuditLog } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { resolveIssuer } from "@/lib/api-key-audit";

/**
 * List every non-deleted agent. Key-authenticated counterpart to the
 * session `GET /api/agents` — this route is admin/org-scoped and returns
 * ALL agents via `listAgents({ scope: "all" })`, with no per-user visibility
 * filtering (design D4). Read-only: no audit entry.
 */
export const GET = withApiKey(["agents:read"], async () => {
  const agents = await listAgents({ scope: "all" });
  return NextResponse.json({ agents });
});

/**
 * Create an agent from a template via an API key. Key-authenticated
 * counterpart to the session `POST /api/agents` — both wrap the same
 * auth-/audit-/HTTP-agnostic `createAgent()` service (#572) and map its
 * discriminated result onto identical response bodies. This route differs
 * only in auth (`withApiKey` instead of `withAdmin`) and audit actor:
 * `actorType: "api_key"` with an issuer-delegation snapshot in `detail`
 * (design D2), instead of `actorType: "user"`.
 */
export const POST = withApiKey(["agents:write"], async (req, _ctx, key) => {
  const parsed = await parseRequestBody(createAgentSchema, req);
  if ("error" in parsed) return parsed.error;

  const result = await createAgent(parsed.data, key.issuerUserId);

  if (!result.ok) {
    // Only the capability path (422) is audited — parity with the session
    // route (plain 400 validation failures were never logged there either).
    if (result.error.status === 422) {
      const issuer = await resolveIssuer(key.issuerUserId);
      await appendAuditLog({
        actorType: "api_key",
        actorId: key.keyId,
        eventType: "agent.created",
        outcome: "failure",
        detail: {
          ...result.error.capabilityFailure,
          apiKey: { id: key.keyId, name: key.name },
          issuer,
        },
      });
    }
    return NextResponse.json(result.error.body, { status: result.error.status });
  }

  const { agent, audit, autoConfiguredPermissions } = result;
  const issuer = await resolveIssuer(key.issuerUserId);

  // Registered only after createAgent() fully succeeds: a throw mid-creation
  // (permissions/workspace/regen → 500) must NOT queue a false "success" audit.
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
        issuer,
      },
      outcome: "success",
    })
  );

  for (const entry of autoConfiguredPermissions) {
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
        issuer,
      },
      outcome: "success",
    });
  }

  // A key-created agent must appear in the admin UI immediately, same as a
  // session-created one.
  revalidatePath("/", "layout");

  return NextResponse.json(agent, { status: 201 });
});
