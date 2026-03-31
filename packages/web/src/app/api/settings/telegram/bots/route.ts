import { NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { getSetting } from "@/lib/settings";
import { db } from "@/db";

export async function GET() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  // No visibility filtering — this endpoint answers "which Telegram bots exist?"
  // for the pairing UI. All authenticated users need to see available bots to
  // link their Telegram account, regardless of agent access permissions.
  // Access control happens via allow-from stores, not here.
  const allAgents = await db.query.agents.findMany();

  const bots: { agentId: string; agentName: string; botUsername: string; isPersonal: boolean }[] =
    [];
  for (const agent of allAgents) {
    const botUsername = await getSetting(`telegram_bot_username:${agent.id}`);
    if (botUsername) {
      bots.push({
        agentId: agent.id,
        agentName: agent.name,
        botUsername,
        isPersonal: agent.isPersonal,
      });
    }
  }

  // Sort personal agents (Smithers) first — the pairing UI uses bots[0] as
  // the primary bot for the QR code. Users should always pair via Smithers
  // (the shared entry point), not via a restricted agent's bot.
  bots.sort((a, b) => (a.isPersonal === b.isPersonal ? 0 : a.isPersonal ? -1 : 1));

  return NextResponse.json({ bots });
}
