import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { directSessionKey } from "@/lib/session-key";
import { resolveRetryGate } from "@/server/chat-session-errors";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * Would retrying this session's last failed run risk DUPLICATING writes?
 *
 * Asked when the user presses Retry, not when the run failed — that timing IS
 * the fix for #1013. OpenClaw fires its `after_tool_call` hook without awaiting
 * it, so the `tool.*` audit row that proves the agent acted can still be in
 * flight when the error reaches Pinchy. The answer computed then can be a false
 * `false`, and a false `false` means an unguarded Retry on a run that already
 * booked an invoice. Seconds later, at click time, the row has landed.
 *
 * The run window comes from the stored row, never from the caller. A `?since=`
 * parameter would turn this into an oracle over a shared agent's tool activity,
 * which a non-admin has no other way to query (`/api/audit` is admin-only). The
 * session key is built from the caller's own id for the same reason.
 *
 * Read-only, hence no audit entry.
 */
export const GET = withAuth<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  const chatId = request.nextUrl.searchParams.get("chatId") ?? undefined;
  const sessionKey = directSessionKey(agentId, session.user.id!, chatId);

  return NextResponse.json({ sideEffects: await resolveRetryGate({ sessionKey, agentId }) });
});
