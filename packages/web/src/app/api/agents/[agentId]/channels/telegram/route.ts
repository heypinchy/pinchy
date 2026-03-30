import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { validateTelegramBotToken } from "@/lib/telegram";
import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";
import { updateTelegramChannelConfig } from "@/lib/openclaw-config";
import {
  clearAllowStoreForAccount,
  recalculateTelegramAllowStores,
} from "@/lib/telegram-allow-store";
import { db } from "@/db";
import { agents, settings } from "@/db/schema";
import { eq, like } from "drizzle-orm";

export async function GET(req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { agentId } = await params;

  const botToken = await getSetting(`telegram_bot_token:${agentId}`);
  if (!botToken) {
    return NextResponse.json({ configured: false });
  }

  const hint = botToken.slice(-4);
  return NextResponse.json({ configured: true, hint });
}

export async function POST(req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { agentId } = await params;
  const { botToken } = await req.json();

  if (!botToken || typeof botToken !== "string") {
    return NextResponse.json({ error: "Bot token is required" }, { status: 400 });
  }

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
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

  // DB first (source of truth)
  await setSetting(`telegram_bot_token:${agentId}`, botToken, true);
  await setSetting(`telegram_bot_username:${agentId}`, validation.botUsername!, false);

  // Update only Telegram channel config (targeted write — preserves OpenClaw-enriched
  // fields like agents.defaults to avoid hot-reloads that break polling)
  updateTelegramChannelConfig(
    agentId,
    { botToken },
    null // Don't touch identityLinks — preserved from existing config
  );

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
  });

  return NextResponse.json({
    botUsername: validation.botUsername,
    botId: validation.botId,
  });
}

export async function DELETE(req: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;
  const { agentId } = await params;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Personal agents (Smithers) can only be disconnected via "Remove Telegram for everyone"
  // in Settings. Uses isPersonal flag (not avatarSeed which is user-editable).
  if (agent.isPersonal) {
    return NextResponse.json(
      {
        error:
          "Smithers' bot cannot be disconnected individually. Use 'Remove Telegram for everyone' in Settings.",
      },
      { status: 400 }
    );
  }

  await deleteSetting(`telegram_bot_token:${agentId}`);
  await deleteSetting(`telegram_bot_username:${agentId}`);

  // Clear only this account's allow-from store (other agents' bots are unaffected)
  clearAllowStoreForAccount(agentId);
  // Remove this account from config (other accounts preserved)
  updateTelegramChannelConfig(agentId, null, null);

  await appendAuditLog({
    actorType: "user",
    actorId: admin.user.id,
    eventType: "channel.deleted",
    resource: `agent:${agentId}`,
    detail: {
      name: `telegram:${agent.name}`,
      agent: { id: agentId, name: agent.name },
      channel: "telegram",
    },
  });

  return NextResponse.json({ success: true });
}
