import { NextRequest, NextResponse } from "next/server";
import { revalidatePath } from "next/cache";
import { updateAgent, deleteAgent } from "@/lib/agents";
import { auth } from "@/lib/auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { appendAuditLog } from "@/lib/audit";

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
  const data: {
    name?: string;
    model?: string;
    allowedTools?: string[];
    pluginConfig?: unknown;
    greetingMessage?: string | null;
  } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.model !== undefined) data.model = body.model;
  if (body.allowedTools !== undefined) data.allowedTools = body.allowedTools;
  if (body.pluginConfig !== undefined) data.pluginConfig = body.pluginConfig;
  if (body.greetingMessage !== undefined) data.greetingMessage = body.greetingMessage;

  const agent = await updateAgent(agentId, data);

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "agent.updated",
    resource: `agent:${agentId}`,
    detail: { changes: Object.keys(data) },
  }).catch(() => {});

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

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "agent.deleted",
    resource: `agent:${agentId}`,
    detail: { name: agent.name },
  }).catch(() => {});

  revalidatePath("/", "layout");

  return NextResponse.json({ success: true });
}
