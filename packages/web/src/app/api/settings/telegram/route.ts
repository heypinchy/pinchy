// audit-exempt: User self-service action (linking own Telegram account), not an admin operation
import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
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

  const client = getOpenClawClient();

  // Approve the pairing via OpenClaw Gateway
  let telegramUserId: string;
  try {
    if (client.hasMethod("pairing.approve")) {
      const result = await client.pairing.approve("telegram", code);
      telegramUserId = String((result as Record<string, unknown>)?.userId ?? "");
    } else {
      return NextResponse.json(
        {
          error: "Pairing approval not available. Please contact your administrator.",
        },
        { status: 501 }
      );
    }
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Pairing failed" },
      { status: 400 }
    );
  }

  if (!telegramUserId) {
    return NextResponse.json(
      { error: "Could not determine Telegram user ID from pairing response" },
      { status: 500 }
    );
  }

  // Store link in DB
  await db.insert(channelLinks).values({
    userId: session.user.id,
    channel: "telegram",
    channelUserId: telegramUserId,
  });

  // Update identityLinks in OpenClaw config
  const configResult = await client.config.get();
  const hash = (configResult as Record<string, unknown>).hash as string;
  const patch = {
    session: {
      identityLinks: {
        [session.user.id]: [`telegram:${telegramUserId}`],
      },
    },
  };
  await client.config.patch(JSON.stringify(patch), hash);

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
  const client = getOpenClawClient();
  const configResult = await client.config.get();
  const hash = (configResult as Record<string, unknown>).hash as string;
  await client.config.patch(
    JSON.stringify({ session: { identityLinks: { [session.user.id]: null } } }),
    hash
  );

  return NextResponse.json({ linked: false });
}
