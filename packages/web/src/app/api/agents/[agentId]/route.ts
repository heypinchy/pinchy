import { NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { agents } from "@/db/schema";
import { eq } from "drizzle-orm";
import { updateAgent, deleteAgent } from "@/lib/agents";
import { auth } from "@/lib/auth";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  return NextResponse.json(agent);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const { agentId } = await params;
  const body = await request.json();
  const data: { name?: string; model?: string } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.model !== undefined) data.model = body.model;
  const agent = await updateAgent(agentId, data);
  return NextResponse.json(agent);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { agentId } = await params;

  const agent = await db.query.agents.findFirst({
    where: eq(agents.id, agentId),
  });

  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  if (agent.isPersonal) {
    return NextResponse.json({ error: "Personal agents cannot be deleted" }, { status: 400 });
  }

  await deleteAgent(agentId);

  return NextResponse.json({ success: true });
}
