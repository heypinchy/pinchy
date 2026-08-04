// audit-exempt: Linking/unlinking one's own Telegram account is a user
// self-service action, not an admin operation. Denied pairing attempts ARE
// audited (auth.telegram_pairing_denied, throttled) — see
// lib/telegram-pairing-security.ts — because that path is the brute-force
// surface; the exemption covers success/unlink only.
import { NextResponse } from "next/server";
import { z } from "zod";
import { withAuth } from "@/lib/api-auth";
import { resolvePairingCode } from "@/lib/telegram-pairing";
import {
  tryAcquireTelegramPairingSlot,
  recordTelegramPairingFailure,
  isChannelUserIdConflictError,
} from "@/lib/telegram-pairing-security";
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

  // Brute-force guard: pairing codes are short human-typed strings with no
  // rate limit of their own otherwise, and a successful guess against
  // another user's pending code hands the attacker that user's full
  // Telegram transcript (see lib/telegram-pairing-security.ts).
  if (!tryAcquireTelegramPairingSlot(session.user.id)) {
    await recordTelegramPairingFailure(session.user.id, "rate_limited");
    return NextResponse.json(
      { error: "Too many pairing attempts. Wait a few minutes and try again." },
      { status: 429 }
    );
  }

  // Resolve pairing code to Telegram user ID by reading OpenClaw's pairing file
  const pairing = resolvePairingCode(code);
  if (!pairing.found) {
    await recordTelegramPairingFailure(session.user.id, "invalid_or_expired_code");
    return NextResponse.json(
      { error: "Invalid or expired pairing code. Send a new message to the bot and try again." },
      { status: 400 }
    );
  }

  const { telegramUserId } = pairing;

  // DB first (source of truth). onConflictDoUpdate handles re-linking
  // to a different Telegram account (unique constraint on userId+channel).
  // A second unique constraint (channel+channelUserId) guards the reverse
  // direction — one Telegram account cannot be linked to two Pinchy users —
  // and isn't an onConflictDoUpdate target, so it still raises; caught below
  // and turned into an honest 409 instead of a raw Postgres error.
  try {
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
  } catch (err) {
    if (isChannelUserIdConflictError(err)) {
      await recordTelegramPairingFailure(session.user.id, "channel_user_id_conflict");
      return NextResponse.json(
        { error: "This Telegram account is already linked to a different Pinchy user." },
        { status: 409 }
      );
    }
    throw err;
  }

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
