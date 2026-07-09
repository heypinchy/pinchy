import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { validateGatewayToken } from "@/lib/gateway-auth";
import { parseRequestBody } from "@/lib/api-validation";
import { captureChannelMessageSchema } from "@/lib/schemas/channel-messages";
import { db } from "@/db";
import { channelMessages, agents } from "@/db/schema";
import { mirrorChannelMedia } from "@/server/channel-media";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";

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
 * This exemption covers the MESSAGE insert only — an inbound media file copy
 * (below) is a distinct workspace filesystem state change and IS audited,
 * one "channel.media_mirrored" row per file, success or failure.
 */
// audit-exempt: high-volume internal transcript ingestion; the captured rows are
// the conversation record, so a per-message audit entry adds no accountability.
// Media copies ARE audited separately below (channel.media_mirrored).
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

  // Media mirroring is best-effort and must never fail message capture: the
  // message row above is already committed by the time we get here, so any
  // problem mirroring the attached file(s) is reported via audit only.
  if (payload.media?.length) {
    await mirrorAndAuditMedia(session.agentId, payload.channel, payload.media);
  }

  return NextResponse.json({ success: true });
}

async function mirrorAndAuditMedia(
  agentId: string,
  channel: string,
  media: Array<{ path: string; mimeType?: string }>
): Promise<void> {
  try {
    const agentRow = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    const agentName = agentRow?.name ?? null;

    const results = await mirrorChannelMedia({ agentId, media });

    for (const result of results) {
      const entry: AuditLogEntry = {
        actorType: "system",
        actorId: "channel-media-mirror",
        eventType: "channel.media_mirrored",
        resource: `agent:${agentId}`,
        outcome: result.outcome,
        detail: {
          channel,
          agent: { id: agentId, name: agentName },
          filename: result.filename,
          mimeType: result.mimeType,
          bytes: result.bytes,
          ...(result.error !== undefined ? { error: result.error } : {}),
        },
      };
      try {
        await appendAuditLog(entry);
      } catch (err) {
        recordAuditFailure(err, entry);
      }
    }
  } catch (err) {
    // mirrorChannelMedia (or the agent-name lookup) threw unexpectedly —
    // never let a media-mirroring bug fail message capture. Report it the
    // same way a failed audit write is reported, so it's still visible in
    // the structured stderr signal / failure counter.
    const entry: AuditLogEntry = {
      actorType: "system",
      actorId: "channel-media-mirror",
      eventType: "channel.media_mirrored",
      resource: `agent:${agentId}`,
      outcome: "failure",
      detail: {
        channel,
        agent: { id: agentId, name: null },
        filename: media.length === 1 ? media[0].path.split("/").pop()! : `${media.length} files`,
        mimeType: null,
        bytes: null,
        error: err instanceof Error ? err.message : String(err),
      },
    };
    recordAuditFailure(err, entry);
  }
}
