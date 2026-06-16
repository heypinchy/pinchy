import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getOpenClawClient } from "@/server/openclaw-client";
import { classifyUserSessions, type RawSession } from "@/lib/chats/classify-sessions";
import type { ChatListItem } from "@/lib/schemas/sessions";
import { db } from "@/db";
import { channelLinks } from "@/db/schema";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * List the requesting user's own chats with this agent. Read-only overview for
 * the Chats UI — the authorization boundary lives in `classifyUserSessions`,
 * which fails closed on anything it can't positively attribute to this user.
 */
// audit-exempt: read-only chats list — no state change.
export const GET = withAuth<RouteContext>(async (_request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  const userId = session.user.id!;

  // Telegram peers linked to THIS user, lowercased — the classifier compares
  // verbatim against OpenClaw's lowercased principal segment, so a peer id that
  // isn't lowercased here would silently never match.
  const links = await db
    .select()
    .from(channelLinks)
    .where(and(eq(channelLinks.channel, "telegram"), eq(channelLinks.userId, userId)));
  const linkedTelegramPeerIds = new Set(links.map((l) => l.channelUserId.toLowerCase()));

  // `sessions.list` is untyped wire output: `{ sessions?: RawSession[] }`.
  let raw: { sessions?: RawSession[] } | undefined;
  try {
    raw = (await getOpenClawClient().sessions.list({})) as { sessions?: RawSession[] } | undefined;
  } catch {
    // OpenClaw unreachable / mid-reconnect. 502 (not 500) so the client can
    // surface a retryable "couldn't load chats" toast rather than a hard error.
    return NextResponse.json({ error: "Failed to load chats" }, { status: 502 });
  }
  const sessionsArr = Array.isArray(raw?.sessions) ? raw.sessions : [];

  // Scope to THIS agent before classifying — the classifier checks identity and
  // key shape but not the agentId, so cross-agent isolation is enforced here.
  // Keys are `agent:<agentId>:direct:<principal>[:<chatId>]`.
  const scoped = sessionsArr.filter(
    (s) => typeof s?.key === "string" && s.key.split(":")[1] === agentId
  );

  const classified = classifyUserSessions(scoped, userId, linkedTelegramPeerIds);

  // Carry the human-readable title (the session label, if any) and sort by
  // recency so the most recent conversation surfaces first. The internal
  // session `key` stays server-side — the client only needs the fields in
  // `ChatListItem`.
  const labelByKey = new Map(scoped.map((s) => [s.key, s.label ?? null]));
  const chats: ChatListItem[] = classified
    .map((c) => ({
      chatId: c.chatId,
      sessionId: c.sessionId,
      origin: c.origin,
      writable: c.writable,
      title: labelByKey.get(c.key) ?? null,
      lastInteractionAt: c.lastInteractionAt,
    }))
    .sort((a, b) => b.lastInteractionAt - a.lastInteractionAt);

  return NextResponse.json({ chats });
});
