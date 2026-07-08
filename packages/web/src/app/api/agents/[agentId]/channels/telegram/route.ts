import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireAdmin, withAuth } from "@/lib/api-auth";
import {
  validateTelegramBotToken,
  hasMainTelegramBot,
  probeTelegramPollingConflict,
} from "@/lib/telegram";
import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";
import { updateTelegramChannelConfig } from "@/lib/openclaw-config";
import {
  clearAllowStoreForAccount,
  recalculateTelegramAllowStores,
} from "@/lib/telegram-allow-store";
import { db } from "@/db";
import { agents, channelLinks, settings } from "@/db/schema";
import { eq, like } from "drizzle-orm";
import { parseRequestBody } from "@/lib/api-validation";

const setBotTokenSchema = z.object({
  botToken: z.string().min(1),
});

export async function GET(req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { agentId } = await params;

  const [agent, botToken, globalMainBot] = await Promise.all([
    db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      columns: { isPersonal: true },
    }),
    getSetting(`telegram_bot_token:${agentId}`),
    hasMainTelegramBot(),
  ]);

  // Personal agents (Smithers) are themselves the main bot — the prerequisite
  // is trivially satisfied from their perspective, otherwise first-time setup
  // would hit an unresolvable chicken-and-egg.
  const mainBotConfigured = agent?.isPersonal ? true : globalMainBot;

  if (!botToken) {
    return NextResponse.json({ configured: false, mainBotConfigured });
  }

  const hint = botToken.slice(-4);

  // #477 layer 2: surface the auto-disable state so the UI can show a
  // persistent, actionable banner instead of silently looking "connected"
  // while config regeneration is actually skipping this account.
  const disabledRaw = await getSetting(`telegram_conflict_disabled:${agentId}`);
  let conflictDisabled = false;
  let conflictDisabledAt: string | undefined;
  let lastError: string | undefined;
  if (disabledRaw) {
    try {
      const parsed = JSON.parse(disabledRaw) as {
        reason?: string;
        lastError?: string;
        disabledAt?: string;
      };
      conflictDisabled = true;
      conflictDisabledAt = parsed.disabledAt;
      lastError = parsed.lastError;
    } catch {
      // Malformed marker — treat as disabled (fail safe) without the extra detail.
      conflictDisabled = true;
    }
  }

  return NextResponse.json({
    configured: true,
    hint,
    mainBotConfigured,
    conflictDisabled,
    ...(conflictDisabledAt ? { conflictDisabledAt } : {}),
    ...(lastError ? { lastError } : {}),
  });
}

export async function POST(req: NextRequest, { params }: { params: Promise<{ agentId: string }> }) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { agentId } = await params;
  const parsed = await parseRequestBody(setBotTokenSchema, req);
  if ("error" in parsed) return parsed.error;
  const { botToken } = parsed.data;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Guard: main Telegram bot must exist before additional agents can connect.
  // Users can only link their Telegram account via the main bot — without it,
  // per-agent bots have no way to reach any user. Personal agents (Smithers)
  // are exempt because they ARE the main bot being set up.
  if (!agent.isPersonal && !(await hasMainTelegramBot())) {
    return NextResponse.json({ error: "telegram_not_configured" }, { status: 409 });
  }

  // Validate token via Telegram API first (gives us the botId for duplicate check)
  const validation = await validateTelegramBotToken(botToken);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // Check for duplicate bot token — Telegram only allows one getUpdates consumer per token.
  // Compare bot IDs (first part of token: "<botId>:<secret>") across all configured agents.
  const existingTokenSettings = await db
    .select()
    .from(settings)
    .where(like(settings.key, "telegram_bot_token:%"));

  const newBotId = botToken.split(":")[0];
  for (const row of existingTokenSettings) {
    if (row.key === `telegram_bot_token:${agentId}`) continue; // same agent, allow re-connect
    const existingToken = await getSetting(row.key);
    if (existingToken && existingToken.split(":")[0] === newBotId) {
      return NextResponse.json(
        { error: "This bot token is already in use by another agent" },
        { status: 409 }
      );
    }
  }

  // Point-in-time probe: reject a token another deployment (staging, prod, a
  // local stack) is already polling right now. Best-effort only — see
  // probeTelegramPollingConflict's doc comment — so it never blocks a connect
  // for any reason other than a confirmed Telegram getUpdates 409. Runs after
  // getMe validation and the duplicate-token check so it only fires for an
  // otherwise-valid, not-already-connected-here token (issue #477 layer 1).
  //
  // Skip the probe on a self-reconnect: if this agent already has this exact
  // token stored, OpenClaw's own worker for THIS deployment is the (only)
  // poller. Probing getUpdates would then race our own poller and can
  // false-positive with a 409, wrongly rejecting a legitimate re-connect as an
  // "another deployment" conflict. A genuinely new token has no such poller yet.
  const currentToken = await getSetting(`telegram_bot_token:${agentId}`);
  if (currentToken !== botToken) {
    const conflictProbe = await probeTelegramPollingConflict(botToken);
    if (conflictProbe.conflict) {
      return NextResponse.json(
        {
          error:
            "This bot is already being polled by another deployment (for example a staging or production stack). Use a separate bot token per environment, or disconnect it there first.",
        },
        { status: 409 }
      );
    }
  }

  // DB first (source of truth)
  await setSetting(`telegram_bot_token:${agentId}`, botToken, true);
  await setSetting(`telegram_bot_username:${agentId}`, validation.botUsername!, false);
  // #477 layer 2: a successful (re)connect clears any prior auto-disable, so
  // the next config regen includes this account again — this is the
  // [Reconnect] path referenced in the disabled-state UI.
  await deleteSetting(`telegram_conflict_disabled:${agentId}`);

  // Update only Telegram channel config (targeted write — preserves OpenClaw-enriched
  // fields like agents.defaults to avoid hot-reloads that break polling).
  // updateTelegramChannelConfig() also notifies restart-state on actual write so
  // /api/health/openclaw reflects the pending OC restart.
  updateTelegramChannelConfig(agentId, { botToken });

  // Populate allow-from store with all linked users who have permission to this agent
  await recalculateTelegramAllowStores();

  await appendAuditLog({
    actorType: "user",
    actorId: admin.user.id,
    eventType: "channel.created",
    resource: `agent:${agentId}`,
    detail: {
      agent: { id: agentId, name: agent.name },
      channel: "telegram",
      botUsername: validation.botUsername,
    },
    outcome: "success",
  });

  return NextResponse.json({
    botUsername: validation.botUsername,
    botId: validation.botId,
  });
}

export const DELETE = withAuth<{ params: Promise<{ agentId: string }> }>(
  async (_req, { params }, session) => {
    const { agentId } = await params;

    const agent = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });
    if (!agent) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Gap 2 (#476): a personal agent's owner may disconnect its own bot without
    // an admin — the org-wide "Remove Telegram for everyone" was the only prior
    // path and is too blunt for a single user's Smithers. Admins can disconnect
    // any agent (shared or personal). The connect path stays admin-only.
    const isOwner = agent.isPersonal && agent.ownerId === session.user.id;
    if (session.user.role !== "admin" && !isOwner) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    await deleteSetting(`telegram_bot_token:${agentId}`);
    await deleteSetting(`telegram_bot_username:${agentId}`);
    // #477 layer 2: no orphan disabled-marker left behind for a bot that's
    // been fully disconnected and may later be reconnected with a fresh token.
    await deleteSetting(`telegram_conflict_disabled:${agentId}`);

    // Clear only this account's allow-from store (other agents' bots are unaffected)
    clearAllowStoreForAccount(agentId);
    // Remove this account from config (other accounts preserved).
    // updateTelegramChannelConfig() notifies restart-state on actual write.
    updateTelegramChannelConfig(agentId, null);

    // Gap 3 (#476): if this was the last Telegram bot, clear the user↔telegram-user
    // channel_links so a later re-registered bot can't re-grant access to stale
    // pairings without re-pairing. The org-wide "Remove Telegram for everyone"
    // already clears channel_links; this closes the per-agent-removal path where
    // every bot is gone individually but the links persisted.
    const remainingBotTokens = await db
      .select()
      .from(settings)
      .where(like(settings.key, "telegram_bot_token:%"));
    let channelLinksCleared = 0;
    if (remainingBotTokens.length === 0) {
      const clearedLinks = await db
        .delete(channelLinks)
        .where(eq(channelLinks.channel, "telegram"))
        .returning({ id: channelLinks.id });
      channelLinksCleared = clearedLinks.length;
    }

    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id,
      eventType: "channel.deleted",
      resource: `agent:${agentId}`,
      detail: {
        name: `telegram:${agent.name}`,
        agent: { id: agentId, name: agent.name },
        channel: "telegram",
        // Gap 3 (#476) hardening: a normal member disconnecting their own
        // personal bot can trigger an org-wide channel_links wipe if it was
        // the last Telegram bot. Surface the count here so the sweep is
        // attributable, not silent — 0 when other bots remain.
        channelLinksCleared,
      },
      outcome: "success",
    });

    return NextResponse.json({ success: true });
  }
);
