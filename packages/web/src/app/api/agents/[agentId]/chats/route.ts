import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getOpenClawClient } from "@/server/openclaw-client";
import { classifyUserSessions, type RawSession } from "@/lib/chats/classify-sessions";
import { firstUserMessageTitle } from "@/lib/chats/first-user-message-title";
import type { RawHistoryMessage } from "@/lib/chats/telegram-transcript";
import type { ChatListItem } from "@/lib/schemas/sessions";
import { db } from "@/db";
import { channelLinks } from "@/db/schema";

type RouteContext = { params: Promise<{ agentId: string }> };

// How many trailing history entries to read when deriving a title — we only
// need the FIRST user message, but OpenClaw returns the newest entries, so we
// pull a small window that reliably contains the opening turn of short chats.
const TITLE_HISTORY_LIMIT = 30;

/**
 * Short-lived, process-local cache of derived titles, keyed by sessionId. The
 * dropdown re-fetches on every open, and a chat's first user message never
 * changes, so a brief TTL spares us re-reading the same transcripts on rapid
 * re-opens. Best-effort: it's fine for entries to be evicted or for the process
 * to restart cold.
 */
const TITLE_CACHE_TTL_MS = 60_000;
const titleCache = new Map<string, { title: string | null; at: number }>();

/**
 * Derive a labelless web chat's title from its first user message, with a brief
 * cache. Returns `null` (the date-fallback signal) when the chat has no usable
 * user message or its history can't be read — a title is a convenience, never a
 * reason to fail the whole list.
 */
async function deriveWebChatTitle(sessionKey: string, sessionId: string): Promise<string | null> {
  const cached = titleCache.get(sessionId);
  if (cached && Date.now() - cached.at < TITLE_CACHE_TTL_MS) return cached.title;

  let title: string | null = null;
  try {
    const raw = (await getOpenClawClient().sessions.history(sessionKey, {
      limit: TITLE_HISTORY_LIMIT,
    })) as { messages?: RawHistoryMessage[] } | undefined;
    title = firstUserMessageTitle(raw?.messages ?? []);
  } catch {
    // History unreachable — fall back to the date-stamped label client-side.
    title = null;
  }

  titleCache.set(sessionId, { title, at: Date.now() });
  return title;
}

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

  // Carry the human-readable title and sort by recency so the most recent
  // conversation surfaces first. The internal session `key` stays server-side —
  // the client only needs the fields in `ChatListItem`.
  //
  // Title precedence: the saved session label wins; otherwise, for the user's
  // OWN web chats, derive it from the first user message. Telegram chats keep
  // their label/null (their transcript has a dedicated endpoint), and labelled
  // chats never trigger a history read.
  const labelByKey = new Map(scoped.map((s) => [s.key, s.label ?? null]));
  const chats: ChatListItem[] = (
    await Promise.all(
      classified.map(async (c) => {
        const label = labelByKey.get(c.key) ?? null;
        let title = label;
        if (!title && c.origin === "web") {
          title = await deriveWebChatTitle(c.key, c.sessionId);
        }
        return {
          chatId: c.chatId,
          sessionId: c.sessionId,
          origin: c.origin,
          writable: c.writable,
          title,
          lastInteractionAt: c.lastInteractionAt,
        };
      })
    )
  ).sort((a, b) => b.lastInteractionAt - a.lastInteractionAt);

  return NextResponse.json({ chats });
});
