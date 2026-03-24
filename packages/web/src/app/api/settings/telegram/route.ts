// audit-exempt: User self-service action (linking own Telegram account), not an admin operation
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { resolvePairingCode } from "@/lib/telegram-pairing";
import { getOpenClawClient } from "@/server/openclaw-client";
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

  // DB first (source of truth — survives restarts via regenerateOpenClawConfig at startup)
  await db.insert(channelLinks).values({
    userId: session.user.id,
    channel: "telegram",
    channelUserId: telegramUserId,
  });

  // Fire config.patch for live hot-reload (fire-and-forget — don't call
  // regenerateOpenClawConfig here to avoid race conditions with OpenClaw)
  try {
    const client = getOpenClawClient();
    const configResult = await client.config.get();
    const hash = (configResult as Record<string, unknown>).hash as string;
    client.config
      .patch(
        JSON.stringify({
          channels: { telegram: { allowFrom: [telegramUserId] } },
          session: { identityLinks: { [session.user.id]: [`telegram:${telegramUserId}`] } },
        }),
        hash
      )
      .catch(() => {});
  } catch {
    // OpenClaw not connected — changes picked up on next restart
  }

  return NextResponse.json({ linked: true, telegramUserId });
}

export async function DELETE() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // DB first
  await db
    .delete(channelLinks)
    .where(and(eq(channelLinks.userId, session.user.id), eq(channelLinks.channel, "telegram")));

  // Fire config.patch for live hot-reload (fire-and-forget)
  try {
    const client = getOpenClawClient();
    const configResult = await client.config.get();
    const hash = (configResult as Record<string, unknown>).hash as string;
    client.config
      .patch(JSON.stringify({ session: { identityLinks: { [session.user.id]: null } } }), hash)
      .catch(() => {});
  } catch {
    // OpenClaw not connected
  }

  return NextResponse.json({ linked: false });
}
