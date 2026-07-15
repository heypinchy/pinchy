import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { withApiKey } from "@/lib/api-auth";
import { getAgent, deleteAgent } from "@/lib/agents";
import { appendAuditLog } from "@/lib/audit";
import { resolveIssuer } from "@/lib/api-key-audit";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * Fetch a single agent by id via an API key. Key-authenticated counterpart to
 * the session `GET /api/agents/[agentId]` — this route is admin/org-scoped
 * and reads via `getAgent(id, { scope: "all" })`, with no per-user visibility
 * filtering (design D4), same as the collection `GET /api/v1/agents`.
 * Returns the bare agent (not the `{ agents }` collection envelope), matching
 * `POST`'s bare-agent 201. Read-only: no audit entry.
 */
export const GET = withApiKey<RouteContext>(["agents:read"], async (_req, { params }) => {
  const { agentId } = await params;
  const agent = await getAgent(agentId, { scope: "all" });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(agent);
});

/**
 * Delete an agent via an API key. Key-authenticated counterpart to the
 * session `DELETE /api/agents/[agentId]` — both call the same `deleteAgent()`
 * service and enforce the same `isPersonal` guard. This route differs only in
 * auth (`withApiKey` instead of `withAdmin`) and audit actor:
 * `actorType: "api_key"` with an issuer-delegation snapshot in `detail`
 * (design D2), instead of `actorType: "user"`.
 *
 * The `isPersonal` guard is a real governance boundary — a leaked
 * `agents:delete` key must not be able to delete users' personal agents.
 */
export const DELETE = withApiKey<RouteContext>(["agents:delete"], async (_req, { params }, key) => {
  const { agentId } = await params;
  const agent = await getAgent(agentId, { scope: "all" });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  if (agent.isPersonal) {
    return NextResponse.json({ error: "Personal agents cannot be deleted" }, { status: 400 });
  }

  await deleteAgent(agentId);
  const issuer = await resolveIssuer(key.issuerUserId);

  // Registered only after deleteAgent() fully succeeds — the deletion is
  // already committed at that point (can't roll back), so this can safely
  // run post-response via after().
  after(() =>
    appendAuditLog({
      actorType: "api_key",
      actorId: key.keyId,
      eventType: "agent.deleted",
      resource: `agent:${agentId}`,
      detail: {
        name: agent.name,
        apiKey: { id: key.keyId, name: key.name },
        issuer,
      },
      outcome: "success",
    })
  );

  revalidatePath("/", "layout");

  return NextResponse.json({ success: true });
});
