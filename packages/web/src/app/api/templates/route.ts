import { NextRequest, NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";

export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const templates = Object.entries(AGENT_TEMPLATES).map(([id, template]) => ({
    id,
    name: template.name,
    description: template.description,
    requiresDirectories: template.pluginId !== null,
    defaultTagline: template.defaultTagline,
  }));

  return NextResponse.json({ templates });
}
