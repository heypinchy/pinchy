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

  // Take every bot out of the config and empty every allow list, each
  // whichever way the other goes. The config reaches OpenClaw in the
  // background, up to a minute later, and until then the empty lists are what
  // keep the bots from answering anyone. A failing clear must not undo the
  // removal: once the config lands no bot is left to read the lists, and the
  // next recalculation drops them. updateTelegramChannelConfig() notifies
  // restart-state on actual write — and is auto-deduped when there's nothing to
  // remove, avoiding a 30 s overlay for a no-op. A config write that fails
  // still leaves tokens and links gone from the database, so the removal is
  // audited, marked failed, and the error reaches the caller afterwards.
  let configError: unknown = null;
  try {
    updateTelegramChannelConfig(null, null);
  } catch (err) {
    configError = err;
  }
  try {
    await clearAllAllowStores();
  } catch (err) {
    console.error("[telegram] could not clear the allow lists of removed bots:", err);
  }

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
    // A fixed message: the error's own can carry a file system path, and the
    // audit row is immutable.
    ...(configError
      ? {
          outcome: "failure" as const,
          error: { message: "Could not remove the bots from the OpenClaw config" },
        }
      : { outcome: "success" as const }),
  });
  if (configError) throw configError;

  return NextResponse.json({ removed: true });
}
