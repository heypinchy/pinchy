import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-auth";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";
import { getAgentWithAccess } from "@/lib/agent-access";

// Browser telemetry, session-authed: the chat UI reports how long a run kept
// going after the tab lost focus. It lived under `/api/internal/` until #599,
// which was a mislabel with teeth — that prefix means "bearer-token traffic
// from an OpenClaw plugin" to both the domain-lock host check and the CSRF
// gate, so this route inherited two exemptions it has no claim to (the CSRF one
// let a cross-site POST forge a `chat.background_run_completed` row using the
// visitor's session). Keep session-authed routes out of `/api/internal/`;
// src/__tests__/security/internal-routes-gateway-auth.test.ts enforces it.

// Cap at 10 minutes — `durationMs` is client-supplied telemetry, so a
// sanity bound prevents a misbehaving (or malicious) client from skewing
// metrics with absurd values. A turn longer than 10 minutes is itself a
// signal worth investigating, not data to feed into normal aggregations.
const MAX_BACKGROUND_RUN_DURATION_MS = 10 * 60 * 1000;

const BackgroundRunBody = z.object({
  agentId: z.string().min(1),
  durationMs: z.number().int().nonnegative().max(MAX_BACKGROUND_RUN_DURATION_MS),
});

export const POST = withAuth(async (req: NextRequest, _ctx, session) => {
  const parsed = await parseRequestBody(BackgroundRunBody, req);
  if ("error" in parsed) return parsed.error;

  const { agentId, durationMs } = parsed.data;

  // Verify the agent exists and the user has access to it.
  // This prevents authenticated users from writing fake telemetry for agents they don't own.
  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "chat.background_run_completed",
    resource: `agent:${agentId}`,
    detail: { agent: { id: agentId, name: agent.name }, durationMs },
    outcome: "success",
  });

  return new NextResponse(null, { status: 204 });
});
