import { NextRequest, NextResponse } from "next/server";
import { updateAgent, deleteAgent } from "@/lib/agents";
import { auth } from "@/lib/auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(
    agentId,
    session.user.id!,
    session.user.role || "user"
  );
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  return NextResponse.json(agent);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId } = await params;

  const existingAgentOrError = await getAgentWithAccess(
    agentId,
    session.user.id!,
    session.user.role || "user"
  );
  if (existingAgentOrError instanceof NextResponse) return existingAgentOrError;
  const existingAgent = existingAgentOrError;

  const body = await request.json();

  // Only admins can change permissions
  if (body.allowedTools !== undefined) {
    if (session.user.role !== "admin") {
      return NextResponse.json({ error: "Only admins can change permissions" }, { status: 403 });
    }
    if (existingAgent.isPersonal) {
      return NextResponse.json(
        { error: "Cannot change permissions for personal agents" },
        { status: 400 }
      );
    }
  }

  // Build update data
  const data: { name?: string; model?: string; allowedTools?: string[]; pluginConfig?: unknown } =
    {};
  if (body.name !== undefined) data.name = body.name;
  if (body.model !== undefined) data.model = body.model;
  if (body.allowedTools !== undefined) data.allowedTools = body.allowedTools;
  if (body.pluginConfig !== undefined) data.pluginConfig = body.pluginConfig;

  const agent = await updateAgent(agentId, data);

  // Regenerate config when permissions change
  if (data.allowedTools !== undefined || data.pluginConfig !== undefined) {
    await regenerateOpenClawConfig();
  }

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

  const agentOrError = await getAgentWithAccess(
    agentId,
    session.user.id!,
    session.user.role || "user"
  );
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  if (agent.isPersonal) {
    return NextResponse.json({ error: "Personal agents cannot be deleted" }, { status: 400 });
  }

  await deleteAgent(agentId);

  return NextResponse.json({ success: true });
}
