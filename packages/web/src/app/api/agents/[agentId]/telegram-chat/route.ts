import { NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getOpenClawClient } from "@/server/openclaw-client";
import { getSetting } from "@/lib/settings";
import { db } from "@/db";
import { channelLinks } from "@/db/schema";
import { mapTelegramTranscript, type RawHistoryMessage } from "@/lib/chats/telegram-transcript";

type RouteContext = { params: Promise<{ agentId: string }> };

// How many trailing history entries to fetch for the read-only mirror. Matches
// a reasonable chat backlog without pulling an unbounded transcript.
const HISTORY_LIMIT = 200;

/**
 * Read-only mirror of the requesting user's linked Telegram conversation with
 * this agent (#508). Pinchy mirrors Telegram into the web UI read-only — there
 * is no posting from here — so this only fetches and projects the transcript.
 *
 * The Telegram peer is SERVER-DERIVED from the authed user's `channel_links`
 * row; the client never supplies it. That is the authorization boundary: a
 * user can only ever read the session keyed to their own linked peer, so one
 * user's transcript can never leak to another.
 */
// audit-exempt: read-only telegram transcript mirror — no state change.
export const GET = withAuth<RouteContext>(async (_request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  const userId = session.user.id!;

  // The authed user's Telegram peer. One Telegram link per user, so the first
  // (and only) row is the peer. Lowercased to match OpenClaw's stored principal
  // segment — the classifier's contract (see classify-sessions.ts).
  const links = await db
    .select()
    .from(channelLinks)
    .where(and(eq(channelLinks.channel, "telegram"), eq(channelLinks.userId, userId)));

  const peerId = links[0]?.channelUserId?.toLowerCase();
  if (!peerId) {
    return NextResponse.json({ error: "No linked Telegram conversation" }, { status: 404 });
  }

  // Per-task session model: the Telegram conversation is a SEPARATE OpenClaw
  // session from the web chat, keyed by the user's Telegram peer id.
  const sessionKey = `agent:${agentId}:direct:${peerId}`;

  let raw: { messages?: RawHistoryMessage[] } | undefined;
  try {
    raw = (await getOpenClawClient().sessions.history(sessionKey, { limit: HISTORY_LIMIT })) as
      | { messages?: RawHistoryMessage[] }
      | undefined;
  } catch {
    // OpenClaw unreachable / mid-reconnect. 502 (not 500) so the client can
    // surface a retryable "couldn't load conversation" toast.
    return NextResponse.json({ error: "Failed to load Telegram conversation" }, { status: 502 });
  }

  const messages = mapTelegramTranscript(raw?.messages ?? []);

  // "Continue on Telegram" deep link. The bot username is persisted per agent
  // as `telegram_bot_username:<agentId>` when an admin connects the bot (see
  // the agent telegram channel route). Null when this agent has no bot
  // configured — the UI falls back gracefully.
  const botUsername = await getSetting(`telegram_bot_username:${agentId}`);
  const botDeepLink = botUsername ? `https://t.me/${botUsername}` : null;

  return NextResponse.json({ messages, botDeepLink });
});
