// audit-exempt: User self-service action (linking own Telegram account), not an admin operation
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { getOpenClawClient } from "@/server/openclaw-client";
import { resolvePairingCode } from "@/lib/telegram-pairing";
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

  let client;
  try {
    client = getOpenClawClient();
  } catch {
    return NextResponse.json(
      { error: "Agent runtime is not connected. Please try again in a moment." },
      { status: 503 }
    );
  }

  // Add Telegram user to allowFrom and set up identity link via config.patch
  const configResult = await client.config.get();
  const hash = (configResult as Record<string, unknown>).hash as string;
  const patch = {
    channels: {
      telegram: {
        allowFrom: [telegramUserId],
      },
    },
    session: {
      identityLinks: {
        [session.user.id]: [`telegram:${telegramUserId}`],
      },
    },
  };

  try {
    await client.config.patch(JSON.stringify(patch), hash);
  } catch {
    return NextResponse.json(
      { error: "Failed to update agent runtime configuration. Please try again." },
      { status: 502 }
    );
  }

  // Store link in DB
  await db.insert(channelLinks).values({
    userId: session.user.id,
    channel: "telegram",
    channelUserId: telegramUserId,
  });

  return NextResponse.json({ linked: true, telegramUserId });
}

export async function DELETE() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Remove link from DB
  await db
    .delete(channelLinks)
    .where(and(eq(channelLinks.userId, session.user.id), eq(channelLinks.channel, "telegram")));

  // Remove from identityLinks in OpenClaw config
  let client;
  try {
    client = getOpenClawClient();
  } catch {
    return NextResponse.json({ linked: false });
  }

  try {
    const configResult = await client.config.get();
    const hash = (configResult as Record<string, unknown>).hash as string;
    await client.config.patch(
      JSON.stringify({ session: { identityLinks: { [session.user.id]: null } } }),
      hash
    );
  } catch {
    // Config patch failed but DB link is already removed — acceptable
  }

  return NextResponse.json({ linked: false });
}
