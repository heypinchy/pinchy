// audit-exempt: User self-service action (linking own Telegram account), not an admin operation
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-auth";
import { resolvePairingCode } from "@/lib/telegram-pairing";
import { recalculateTelegramAllowStores, removePairingRequest } from "@/lib/telegram-allow-store";
import { db } from "@/db";
import { channelLinks } from "@/db/schema";
import { eq, and } from "drizzle-orm";
import { parseRequestBody } from "@/lib/api-validation";

const linkTelegramSchema = z.object({ code: z.string().min(1) });

export const GET = withAuth(async (_req, _ctx, session) => {
  const link = await db.query.channelLinks.findFirst({
    where: and(eq(channelLinks.userId, session.user.id), eq(channelLinks.channel, "telegram")),
  });

  return NextResponse.json({
    linked: !!link,
    channelUserId: link?.channelUserId ?? null,
  });
});

export const POST = withAuth(async (req, _ctx, session) => {
  const parsed = await parseRequestBody(linkTelegramSchema, req);
  if ("error" in parsed) return parsed.error;
  const { code } = parsed.data;

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

  // #508: per-task session model. We no longer write session.identityLinks —
  // each Telegram peer keeps its own per-peer OpenClaw session rather than
  // being folded into the user's web chat session. Pinchy's own authorization
  // (Chats list, Telegram allow-listing) reads channel_links directly, so the
  // link is fully effective without any identityLinks emission.

  return NextResponse.json({ linked: true, telegramUserId });
});

export const DELETE = withAuth(async (_req, _ctx, session) => {
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

  // #508: per-task session model — no session.identityLinks to update. The
  // per-account allow-from recalculation above (driven by channel_links) is
  // the sole config-side effect of unlinking.

  return NextResponse.json({ linked: false });
});
