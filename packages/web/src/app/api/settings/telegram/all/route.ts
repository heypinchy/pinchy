import { NextResponse } from "next/server";
import { requireAdmin } from "@/lib/api-auth";
import { updateTelegramChannelConfig } from "@/lib/openclaw-config";
import { clearAllAllowStores } from "@/lib/telegram-allow-store";
import { appendAuditLog } from "@/lib/audit";
import { deleteSetting } from "@/lib/settings";
import { db } from "@/db";
import { channelLinks, settings } from "@/db/schema";
import { eq, like } from "drizzle-orm";

export async function DELETE() {
  const admin = await requireAdmin();
  if (admin instanceof NextResponse) return admin;

  // Find all telegram bot token settings to know which agents to clean up
  const botTokenSettings = await db
    .select()
    .from(settings)
    .where(like(settings.key, "telegram_bot_token:%"));

  // Delete all user channel links for telegram
  await db.delete(channelLinks).where(eq(channelLinks.channel, "telegram"));

  // Delete bot token and username settings for each agent
  for (const setting of botTokenSettings) {
    const agentId = setting.key.replace("telegram_bot_token:", "");
    await deleteSetting(`telegram_bot_token:${agentId}`);
    await deleteSetting(`telegram_bot_username:${agentId}`);
  }

  // Clear all per-account allow-from stores and remove all channel config
  clearAllAllowStores();
  updateTelegramChannelConfig(null, null, null);

  await appendAuditLog({
    actorType: "user",
    actorId: admin.user.id,
    eventType: "channel.deleted",
    resource: "settings:telegram",
    detail: {
      name: "telegram",
      channel: "telegram",
      scope: "all",
      botsRemoved: botTokenSettings.length,
    },
  });

  return NextResponse.json({ removed: true });
}
