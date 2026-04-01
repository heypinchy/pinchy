// audit-exempt: User self-service action (linking own Telegram account), not an admin operation
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { resolvePairingCode } from "@/lib/telegram-pairing";
import { updateIdentityLinks } from "@/lib/openclaw-config";
import { recalculateTelegramAllowStores, removePairingRequest } from "@/lib/telegram-allow-store";
import { db } from "@/db";
import { channelLinks } from "@/db/schema";
import { eq, and } from "drizzle-orm";

/**
 * Build identityLinks map from all telegram channel links in DB.
 * Format: { userId: ["telegram:channelUserId"] }
 */
async function buildIdentityLinks(): Promise<Record<string, string[]>> {
  const links = await db.select().from(channelLinks);
  const identityLinks: Record<string, string[]> = {};
  for (const link of links) {
    const identity = `${link.channel}:${link.channelUserId}`;
    if (!identityLinks[link.userId]) {
      identityLinks[link.userId] = [identity];
    } else {
      identityLinks[link.userId].push(identity);
    }
  }
  return identityLinks;
}

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

  // DB first (source of truth). onConflictDoUpdate handles re-linking
  // to a different Telegram account (unique constraint on userId+channel).
  await db
    .insert(channelLinks)
    .values({
      userId: session.user.id,
      channel: "telegram",
      channelUserId: telegramUserId,
    })
    .onConflictDoUpdate({
      target: [channelLinks.userId, channelLinks.channel],
      set: { channelUserId: telegramUserId, linkedAt: new Date() },
    });

  // Clear the pairing request from OpenClaw's store so it doesn't retain
  // any internal "approved" state. The allow-from stores (computed below)
  // become the sole authority for Telegram access.
  removePairingRequest(telegramUserId);

  // Recalculate per-account allow-from stores (permission-aware)
  await recalculateTelegramAllowStores();

  // Update only identityLinks in config (targeted write — no agents.defaults diff,
  // no hot-reload, no Telegram polling disruption)
  updateIdentityLinks(await buildIdentityLinks());

  return NextResponse.json({ linked: true, telegramUserId });
}

export async function DELETE() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // Find the user's telegram ID before deleting
  const existingLink = await db.query.channelLinks.findFirst({
    where: and(eq(channelLinks.userId, session.user.id), eq(channelLinks.channel, "telegram")),
  });

  await db
    .delete(channelLinks)
    .where(and(eq(channelLinks.userId, session.user.id), eq(channelLinks.channel, "telegram")));

  // Remove the pairing request so OpenClaw issues a fresh code on next message
  if (existingLink) {
    removePairingRequest(existingLink.channelUserId);
  }

  // Recalculate per-account allow-from stores (removes unlinked user)
  await recalculateTelegramAllowStores();

  // Update identityLinks (targeted write — removes this user's mapping)
  updateIdentityLinks(await buildIdentityLinks());

  return NextResponse.json({ linked: false });
}
