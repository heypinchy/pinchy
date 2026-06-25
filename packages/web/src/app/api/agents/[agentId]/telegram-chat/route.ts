import { NextResponse } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { getOpenClawClient } from "@/server/openclaw-client";
import { getSetting } from "@/lib/settings";
import { db } from "@/db";
import { channelLinks, channelMessages } from "@/db/schema";
import { mapTelegramTranscript, type RawHistoryMessage } from "@/lib/chats/telegram-transcript";
import type { TelegramTranscriptMessage } from "@/lib/schemas/sessions";

type RouteContext = { params: Promise<{ agentId: string }> };

// How many trailing messages to render in the read-only mirror. Matches a
// reasonable chat backlog without pulling an unbounded transcript.
const HISTORY_LIMIT = 200;

/**
 * Read-only mirror of the requesting user's linked Telegram conversation with
 * this agent (#508). Pinchy renders this from its OWN durable `channel_messages`
 * store (captured by the `pinchy-transcript` plugin), NOT from OpenClaw's
 * session-scoped `chat.history` — so the mirror reflects what the user actually
 * sees in Telegram (where messages persist across resets) and is immune to
 * OpenClaw session semantics (`/new`, the daily reset, compaction, id rotation).
 *
 * Fallback: when Pinchy has captured NOTHING for the peer yet, the conversation
 * likely predates the `pinchy-transcript` plugin (its messages were never
 * mirrored). Rather than show a misleading "empty", we read the peer's OpenClaw
 * session history once as a best-effort seed — the same source the live web chat
 * uses. New messages still flow into the durable store going forward, so this
 * only rescues conversations Pinchy never saw; it does not weaken the #553 win.
 *
 * The Telegram peer is SERVER-DERIVED from the authed user's `channel_links`
 * row; the client never supplies it. That is the authorization boundary: a user
 * can only ever read messages keyed to their own linked peer, so one user's
 * transcript can never leak to another.
 */
// audit-exempt: read-only telegram transcript mirror — no state change.
export const GET = withAuth<RouteContext>(async (_request, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  const userId = session.user.id!;

  // The authed user's Telegram peer. One Telegram link per user, so the first
  // (and only) row is the peer. Lowercased to match the stored `peer_id`.
  const links = await db
    .select()
    .from(channelLinks)
    .where(and(eq(channelLinks.channel, "telegram"), eq(channelLinks.userId, userId)));

  const peerId = links[0]?.channelUserId?.toLowerCase();
  if (!peerId) {
    return NextResponse.json({ error: "No linked Telegram conversation" }, { status: 404 });
  }

  let rows: { direction: string; content: string; sentAt: Date }[];
  try {
    rows = await db
      .select({
        direction: channelMessages.direction,
        content: channelMessages.content,
        sentAt: channelMessages.sentAt,
      })
      .from(channelMessages)
      .where(
        and(
          eq(channelMessages.agentId, agentId),
          eq(channelMessages.channel, "telegram"),
          eq(channelMessages.peerId, peerId)
        )
      )
      // Newest-first + limit so a long conversation renders the most RECENT
      // HISTORY_LIMIT messages (a chat backlog), not the oldest ones.
      .orderBy(desc(channelMessages.sentAt))
      .limit(HISTORY_LIMIT);
  } catch {
    // Transient DB error. 502 so the client surfaces a retryable "couldn't load
    // conversation" toast rather than a hard failure.
    return NextResponse.json({ error: "Failed to load Telegram conversation" }, { status: 502 });
  }

  // Reverse the newest-first query result back to chronological order for display.
  let messages: TelegramTranscriptMessage[] = rows.reverse().map((row) => ({
    role: row.direction === "inbound" ? "user" : "assistant",
    text: row.content,
    timestamp: row.sentAt.getTime(),
  }));

  // Pinchy has no captured messages for this peer. The conversation may predate
  // the transcript plugin, so fall back to the peer's OpenClaw session history
  // (per-task session key, `dmScope: "per-peer"`). Best-effort: a failed read
  // keeps the honest empty result rather than failing the whole request.
  if (messages.length === 0) {
    const sessionKey = `agent:${agentId}:direct:${peerId}`;
    try {
      const raw = (await getOpenClawClient().sessions.history(sessionKey, {
        limit: HISTORY_LIMIT,
      })) as { messages?: RawHistoryMessage[] } | undefined;
      const fallback = mapTelegramTranscript(raw?.messages ?? []);
      if (fallback.length > 0) {
        // A capture gap, surfaced. Expected for pre-existing conversations; if it
        // recurs for ACTIVE chats, the transcript plugin is not capturing.
        console.warn(
          `[telegram-chat] no captured messages for agent ${agentId}; rendering ${fallback.length} from OpenClaw history fallback`
        );
        messages = fallback;
      }
    } catch {
      // History unreachable — leave the empty result intact.
    }
  }

  // "Continue on Telegram" deep link. The bot username is persisted per agent
  // as `telegram_bot_username:<agentId>` when an admin connects the bot. Null
  // when this agent has no bot configured — the UI falls back gracefully.
  const botUsername = await getSetting(`telegram_bot_username:${agentId}`);
  const botDeepLink = botUsername ? `https://t.me/${botUsername}` : null;

  return NextResponse.json({ messages, botDeepLink });
});
