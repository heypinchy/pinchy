import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { validateTelegramBotToken } from "@/lib/telegram";
import { getSetting, setSetting, deleteSetting } from "@/lib/settings";
import { appendAuditLog } from "@/lib/audit";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";

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

  // Validate token via Telegram API
  const validation = await validateTelegramBotToken(botToken);
  if (!validation.valid) {
    return NextResponse.json({ error: validation.error }, { status: 400 });
  }

  // Store in DB, then regenerate OpenClaw config (includes channel, bindings, session)
  await setSetting(`telegram_bot_token:${agentId}`, botToken, true);
  await setSetting(`telegram_bot_username:${agentId}`, validation.botUsername!, false);

  await regenerateOpenClawConfig();

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

  await deleteSetting(`telegram_bot_token:${agentId}`);
  await deleteSetting(`telegram_bot_username:${agentId}`);

  await regenerateOpenClawConfig();

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
