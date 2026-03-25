// audit-exempt: User self-service action (linking own Telegram account), not an admin operation
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { resolvePairingCode } from "@/lib/telegram-pairing";
import { regenerateOpenClawConfig, requestGatewayRestart } from "@/lib/openclaw-config";
import { db } from "@/db";
import { channelLinks } from "@/db/schema";
import { eq, and } from "drizzle-orm";

export async function GET() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const link = await db.query.channelLinks.findFirst({
    where: and(eq(channelLinks.userId, session.user.id), eq(channelLinks.channel, "telegram")),
  });

  return NextResponse.json({
    linked: !!link,
    channelUserId: link?.channelUserId ?? null,
  });
}

export async function POST(req: Request) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { code } = await req.json();
  if (!code || typeof code !== "string") {
    return NextResponse.json({ error: "Pairing code is required" }, { status: 400 });
  }

  // Resolve pairing code to Telegram user ID by reading OpenClaw's pairing file
  const pairing = resolvePairingCode(code);
  if (!pairing.found) {
    return NextResponse.json(
      { error: "Invalid or expired pairing code. Send a new message to the bot and try again." },
      { status: 400 }
    );
  }

  const { telegramUserId } = pairing;

  // DB first (source of truth)
  console.log(
    "[pinchy] POST /settings/telegram: inserting channel link for user",
    session.user.id,
    "telegramUserId",
    telegramUserId
  );
  await db.insert(channelLinks).values({
    userId: session.user.id,
    channel: "telegram",
    channelUserId: telegramUserId,
  });

  // Regenerate config file — OpenClaw detects the change and hot-reloads
  console.log("[pinchy] POST /settings/telegram: calling regenerateOpenClawConfig");
  await regenerateOpenClawConfig();
  console.log("[pinchy] POST /settings/telegram: regenerateOpenClawConfig done");

  return NextResponse.json({ linked: true, telegramUserId });
}

export async function DELETE() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // DB first
  console.log(
    "[pinchy] DELETE /settings/telegram: deleting channel link for user",
    session.user.id
  );
  await db
    .delete(channelLinks)
    .where(and(eq(channelLinks.userId, session.user.id), eq(channelLinks.channel, "telegram")));

  // Workaround for openclaw#47458: OpenClaw's hot-reload breaks Telegram polling.
  // Write restart trigger BEFORE regenerating config. The start-openclaw.sh
  // health-check loop picks it up within 5s and kills the gateway. If OpenClaw
  // detects the config change first and does a broken hot-reload, the kill
  // still happens shortly after and starts a clean process.
  console.log("[pinchy] DELETE /settings/telegram: requesting gateway restart");
  requestGatewayRestart();
  await regenerateOpenClawConfig();
  console.log("[pinchy] DELETE /settings/telegram: done");

  return NextResponse.json({ linked: false });
}
