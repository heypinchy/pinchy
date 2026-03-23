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

  const userId = session.user.id;
  const allAgents = await db.query.agents.findMany();

  // Filter agents the user can access
  const accessibleAgents = allAgents.filter((agent) => {
    if (!agent.isPersonal) return true;
    return agent.ownerId === userId;
  });

  // Find agents with configured Telegram bots
  const bots: { agentId: string; agentName: string; botUsername: string }[] = [];
  for (const agent of accessibleAgents) {
    const botUsername = await getSetting(`telegram_bot_username:${agent.id}`);
    if (botUsername) {
      bots.push({
        agentId: agent.id,
        agentName: agent.name,
        botUsername,
      });
    }
  }

  return NextResponse.json({ bots });
}
