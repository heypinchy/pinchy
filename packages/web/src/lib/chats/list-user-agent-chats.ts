import { and, eq } from "drizzle-orm";

import { db } from "@/db";
import { channelLinks } from "@/db/schema";
import { getOpenClawClient } from "@/server/openclaw-client";
import { classifyUserSessions, type ClassifiedChat, type RawSession } from "./classify-sessions";

// `sessions.list` is untyped wire output.
type SessionsListResult = { sessions?: RawSession[] } | undefined;

/**
 * Enumerate the requesting user's OWN chats with one agent — web (default +
 * named #508) and read-only Telegram peers linked to them. This is the shared,
 * authorized enumeration used by BOTH `GET /api/agents/[agentId]/chats` (which
 * adds titles + sorting on top) and the diagnostics export route (#639, which
 * uses it to authorize a `sessionId` selector before reading a trajectory).
 *
 * The authorization boundary lives entirely in `classifyUserSessions`, which
 * fails closed on anything it can't positively attribute to this user. Keeping
 * this in one place means the export route can't drift from the chats list and
 * accidentally widen what a user may reach.
 *
 * Throws if OpenClaw is unreachable (untyped `sessions.list` rejection) — the
 * caller maps that to a 502 so the client can retry.
 *
 * @returns the classified chats plus a `key → label` map so title-deriving
 *   callers don't need the raw sessions again.
 */
export async function listUserAgentChats(
  agentId: string,
  userId: string
): Promise<{ chats: ClassifiedChat[]; labelByKey: Map<string, string | null> }> {
  // Telegram peers linked to THIS user, lowercased — the classifier compares
  // verbatim against OpenClaw's lowercased principal segment.
  const links = await db
    .select()
    .from(channelLinks)
    .where(and(eq(channelLinks.channel, "telegram"), eq(channelLinks.userId, userId)));
  const linkedTelegramPeerIds = new Set(links.map((l) => l.channelUserId.toLowerCase()));

  const raw = (await getOpenClawClient().sessions.list({})) as SessionsListResult;
  const sessionsArr = Array.isArray(raw?.sessions) ? raw.sessions : [];

  // Scope to THIS agent before classifying — the classifier checks identity and
  // key shape but not the agentId, so cross-agent isolation is enforced here.
  // Keys are `agent:<agentId>:direct:<principal>[:<chatId>]`.
  const scoped = sessionsArr.filter(
    (s) => typeof s?.key === "string" && s.key.split(":")[1] === agentId
  );

  const chats = classifyUserSessions(scoped, userId, linkedTelegramPeerIds);
  const labelByKey = new Map(scoped.map((s) => [s.key, s.label ?? null]));
  return { chats, labelByKey };
}
