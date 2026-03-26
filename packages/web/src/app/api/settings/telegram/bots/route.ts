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
  const isAdmin = session.user.role === "admin";
  const allAgents = await db.query.agents.findMany();

  // Filter agents the user can access (admins see all)
  const accessibleAgents = isAdmin
    ? allAgents
    : allAgents.filter((agent) => {
        // Personal agents: only owner
        if (agent.isPersonal) return agent.ownerId === userId;
        // Restricted visibility: would need group check (skip for non-admin)
        if (agent.visibility === "restricted") return false;
        return true;
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
