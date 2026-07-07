import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { parseRequestBody } from "@/lib/api-validation";
import { getOpenClawClient } from "@/server/openclaw-client";
import { resetSessionSchema } from "@/lib/schemas/sessions";
import { deferAuditLog } from "@/lib/audit-deferred";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * Reset the caller's chat session with this agent (#611) — the real
 * `/reset` slash command. Unlike compaction (summarize, keep transcript in
 * context), reset rotates the OpenClaw session in place: the session key stays
 * the same but its context is cleared, so the next turn starts empty. The old
 * transcript stays on disk, just unreachable from this key.
 *
 * This IS a visible state change (the user's running conversation disappears
 * from this chat), so unlike the non-destructive `/compact` route we audit it —
 * `chat.session_reset`. The RPC is a non-rollbackable side effect, so the audit
 * write is deferred (deferAuditLog) rather than awaited in the hot path.
 */
export const POST = withAuth<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  const parsed = await parseRequestBody(resetSessionSchema, request);
  if ("error" in parsed) return parsed.error;

  // Per-user, per-chat session scoping, identical to
  // ClientRouter.computeSessionKey: agent:<agentId>:direct:<userId>[:<chatId>].
  // The optional chatId (#611) targets the chat the user is looking at on
  // /chat/<agentId>/<chatId>; omitting it resets the default per-user session.
  const base = `agent:${agentId}:direct:${session.user.id!}`;
  const chatId = parsed.data.chatId ?? null;
  const sessionKey = chatId ? `${base}:${chatId}` : base;

  try {
    const client = getOpenClawClient();
    // reason:"reset" flags this as a manual context clear (not OpenClaw's daily
    // auto-rotation, which Pinchy disables — see openclaw-config/build.ts).
    await client.sessions.reset(sessionKey, { reason: "reset" });
  } catch {
    // OpenClaw unreachable / mid-reconnect. 502 (not 500) so the client can
    // surface a retryable toast. The reset never took effect, so there is no
    // state change to audit.
    return NextResponse.json({ error: "Failed to reset session" }, { status: 502 });
  }

  deferAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "chat.session_reset",
    resource: `agent:${agentId}`,
    detail: { agent: { id: agent.id, name: agent.name }, chatId },
    outcome: "success",
  });

  return NextResponse.json({ ok: true });
});
