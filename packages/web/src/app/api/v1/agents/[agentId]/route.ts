import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { withApiKey } from "@/lib/api-auth";
import { getAgent, deleteAgent } from "@/lib/agents";
import { appendAuditLog } from "@/lib/audit";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * Fetch a single shared agent by id via an API key. Key-authenticated
 * counterpart to the session `GET /api/agents/[agentId]` — org-scoped rather
 * than per-user (design D4), same as the collection `GET /api/v1/agents`, and
 * likewise excluding personal agents. Returns the bare agent (not the
 * `{ agents }` collection envelope), matching `POST`'s bare-agent 201.
 * Read-only: no audit entry.
 */
export const GET = withApiKey<RouteContext>(["agents:read"], async (_req, { params }) => {
  const { agentId } = await params;
  const agent = await getAgent(agentId, { scope: "shared" });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  return NextResponse.json(agent);
});

/**
 * Delete a shared agent via an API key. Key-authenticated counterpart to the
 * session `DELETE /api/agents/[agentId]` — both call the same `deleteAgent()`
 * service. This route differs in auth (`withApiKey` instead of `withAdmin`),
 * in audit actor (`actorType: "api_key"` instead of `"user"`), and in how it
 * answers for a personal agent.
 *
 * Personal agents are unreachable here, and the guard is `getAgent`'s
 * `scope: "shared"` — a personal agent never comes back from the lookup, so
 * this 404s exactly as it would for an id that doesn't exist. That is a
 * DELIBERATE divergence from the session route, which answers 400 "Personal
 * agents cannot be deleted": that route is admin-authenticated and its caller
 * can already enumerate every agent, so a distinguishable error tells them
 * nothing new. A key cannot (`GET /api/v1/agents` omits personal agents), so
 * here 400-vs-404 would be an oracle — probe an id, and the status reveals
 * whether some user has a personal agent behind it. Same 404 for "no such
 * agent" and "not yours to see" is what keeps that shut.
 */
export const DELETE = withApiKey<RouteContext>(["agents:delete"], async (_req, { params }, key) => {
  const { agentId } = await params;
  const agent = await getAgent(agentId, { scope: "shared" });
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  // Registered the instant the soft-delete commits — NOT after deleteAgent
  // returns. Its cleanup tail (workspace removal, grant delete, Telegram
  // settings, the OpenClaw regen) runs outside that transaction and can throw,
  // and a key deletes agents unattended, so "the agent is gone and nobody
  // knows who did it" is a real outcome rather than a theoretical one. Same
  // contract as the sibling POST's onCreated; see deleteAgent.
  await deleteAgent(agentId, () =>
    after(() =>
      appendAuditLog({
        actorType: "api_key",
        actorId: key.keyId,
        eventType: "agent.deleted",
        resource: `agent:${agentId}`,
        // The key is the actor and its own snapshot is the attribution — no
        // issuer/delegation field, see the POST route's docblock. `name` is
        // read off the pre-delete lookup, so it survives the soft-delete.
        detail: {
          name: agent.name,
          apiKey: { id: key.keyId, name: key.name },
        },
        outcome: "success",
      })
    )
  );

  revalidatePath("/", "layout");

  return NextResponse.json({ success: true });
});
