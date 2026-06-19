import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { captureChannelMessageSchema } from "@/lib/schemas/channel-messages";
import { db } from "@/db";
import { channelMessages } from "@/db/schema";

/**
 * Parse `agent:<agentId>:direct:<peer>` → { agentId, peer }. Both the agent and
 * the peer are derived from the session key, never trusted from the body — so a
 * buggy/compromised plugin can't mis-attribute a message, and the stored peer
 * stays consistent with the read route's `channel_links`-derived peer. Returns
 * null for any non-direct session (group/other scopes are not mirrored).
 */
function parseDirectSessionKey(sessionKey: string): { agentId: string; peer: string } | null {
  const m = /^agent:([^:]+):direct:([^:]+)$/.exec(sessionKey);
  return m ? { agentId: m[1], peer: m[2] } : null;
}

/**
 * Capture sink for the `pinchy-transcript` plugin. Records one inbound/outbound
 * channel message into Pinchy's durable `channel_messages` store so the
 * read-only conversation mirror renders from Pinchy's own record instead of
 * OpenClaw's session-scoped transcript (robust against /new resets, the daily
 * reset, compaction, and id rotation).
 *
 * Idempotent: the unique index (channel, agent_id, peer_id, direction,
 * external_id) plus ON CONFLICT DO NOTHING means the plugin can safely retry or
 * double-fire a hook without ever double-inserting.
 *
 * audit-exempt: high-volume internal transcript ingestion. The captured rows
 * ARE the conversation record; emitting a separate audit entry per message
 * would bloat the audit log with no added accountability (the plugin is the
 * only, gateway-token-authed caller, mirroring /api/internal/audit/tool-use).
 */
// audit-exempt: high-volume internal transcript ingestion; the captured rows are
// the conversation record, so a per-message audit entry adds no accountability.
export async function POST(request: NextRequest) {
  if (!validateGatewayToken(request.headers)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const parsed = await parseRequestBody(captureChannelMessageSchema, request);
  if ("error" in parsed) return parsed.error;
  const payload = parsed.data;

  const session = parseDirectSessionKey(payload.sessionKey);
  if (!session) {
    return NextResponse.json(
      { error: "sessionKey must be of the form agent:<agentId>:direct:<peer>" },
      { status: 400 }
    );
  }

  try {
    await db
      .insert(channelMessages)
      .values({
        agentId: session.agentId,
        channel: payload.channel,
        // Lowercased to match channel_links.channelUserId and the peer the read
        // route derives.
        peerId: session.peer.toLowerCase(),
        direction: payload.direction,
        externalId: payload.externalId,
        content: payload.content,
        sentAt: new Date(payload.sentAt),
      })
      .onConflictDoNothing();
  } catch {
    // Transient DB error. 503 (not 500) so the plugin's retry loop treats it as
    // retryable and re-delivers the message rather than dropping it.
    return NextResponse.json({ error: "Failed to record channel message" }, { status: 503 });
  }

  return NextResponse.json({ success: true });
}
