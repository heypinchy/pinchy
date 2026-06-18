import { NextRequest, NextResponse } from "next/server";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { captureChannelMessageSchema } from "@/lib/schemas/channel-messages";
import { db } from "@/db";
import { channelMessages } from "@/db/schema";

/**
 * Extract the agent id from a session key (`agent:<agentId>:...`). The agent is
 * derived from the session, never trusted from the body — see the schema doc.
 */
function agentIdFromSessionKey(sessionKey: string): string | undefined {
  return /^agent:([^:]+):/.exec(sessionKey)?.[1];
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

  const agentId = agentIdFromSessionKey(payload.sessionKey);
  if (!agentId) {
    return NextResponse.json(
      { error: "sessionKey must be of the form agent:<agentId>:..." },
      { status: 400 }
    );
  }

  try {
    await db
      .insert(channelMessages)
      .values({
        agentId,
        channel: payload.channel,
        // Lowercased to match channel_links.channelUserId and the direct-session
        // peer segment the read route derives.
        peerId: payload.peerId.toLowerCase(),
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
