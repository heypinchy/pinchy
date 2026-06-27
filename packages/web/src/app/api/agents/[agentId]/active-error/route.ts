import { NextResponse } from "next/server";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { appendAuditLog } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { directSessionKey } from "@/lib/session-key";
import { getActiveChatSessionError, dismissChatSessionError } from "@/server/chat-session-errors";
import { getErrorHint, presentProviderError } from "@/server/error-hints";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * The durable "paused" banner for this agent's conversation. Returns the latest
 * un-superseded, un-dismissed agent error for the caller's session, or null.
 * The optional `chatId` targets the specific chat the user is viewing (#508);
 * omitting it addresses the default per-user session. The session key embeds
 * the caller's own id, so a user can only ever read their own errors.
 */
export const GET = withAuth<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  const chatId = request.nextUrl.searchParams.get("chatId") ?? undefined;
  const sessionKey = directSessionKey(agentId, session.user.id!, chatId);

  const row = await getActiveChatSessionError(sessionKey);
  return NextResponse.json({
    error: row
      ? {
          id: row.id,
          agentName: row.agentName,
          model: row.model,
          errorClass: row.errorClass,
          transientReason: row.transientReason,
          // Banner display only — rewrites OpenClaw's context-overflow /reset
          // advice (#611), matching the live error frame. The stored row keeps
          // the raw text, so the hint below still classifies off it.
          providerError: presentProviderError(row.providerError),
          // The banner renders no hint of its own; derive the same role-gated
          // guidance the live error frame gets (client-router) so a durable
          // provider-rejection points an admin at their provider config (#584).
          hint: getErrorHint(row.providerError, session.user.role),
          sideEffects: row.sideEffects,
          clientMessageId: row.clientMessageId,
          createdAt: row.createdAt,
        }
      : null,
  });
});

/**
 * Dismiss the error the banner is showing, identified by `?id=`. Scoped to the
 * owning user, so one user can never clear another's banner. 404 if the id
 * doesn't match an un-dismissed error owned by the caller (e.g. already
 * superseded). The id rides as a query param because DELETE carries no body
 * through the typed `apiDelete` client.
 */
export const DELETE = withAuth<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  const id = request.nextUrl.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "Error id is required" }, { status: 400 });
  }

  const dismissed = await dismissChatSessionError({ id, userId: session.user.id! });
  if (!dismissed) {
    return NextResponse.json({ error: "Error not found" }, { status: 404 });
  }

  // The dismiss already committed; never let an audit-write failure turn a
  // successful dismiss into a 500. Record the failure for later reconciliation.
  const auditEntry = {
    actorType: "user" as const,
    actorId: session.user.id!,
    eventType: "chat.error_dismissed" as const,
    resource: `agent:${agent.id}`,
    detail: {
      agent: { id: agent.id, name: agent.name },
      errorId: dismissed.id,
      errorClass: dismissed.errorClass,
    },
    outcome: "success" as const,
  };
  try {
    await appendAuditLog(auditEntry);
  } catch (err) {
    recordAuditFailure(err, auditEntry);
  }

  return NextResponse.json({ dismissed: true });
});
