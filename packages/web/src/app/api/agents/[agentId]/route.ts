import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { updateAgent, deleteAgent, AGENT_NAME_MAX_LENGTH } from "@/lib/agents";
import { getSession } from "@/lib/auth";
import { getAgentWithAccess, assertAgentWriteAccess } from "@/lib/agent-access";
import { appendAuditLog } from "@/lib/audit";
import { writeIdentityFile } from "@/lib/workspace";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  return NextResponse.json(agent);
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { agentId } = await params;

  const existingAgentOrError = await getAgentWithAccess(
    agentId,
    session.user.id!,
    session.user.role
  );
  if (existingAgentOrError instanceof NextResponse) return existingAgentOrError;
  const existingAgent = existingAgentOrError;

  // Only admins or personal agent owners can modify agents
  try {
    assertAgentWriteAccess(existingAgent, session.user.id!, session.user.role);
  } catch {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const body = await request.json();

  if (
    body.name !== undefined &&
    typeof body.name === "string" &&
    body.name.length > AGENT_NAME_MAX_LENGTH
  ) {
    return NextResponse.json(
      { error: `Name must be ${AGENT_NAME_MAX_LENGTH} characters or less` },
      { status: 400 }
    );
  }

  // Only admins can change permissions on shared agents
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
    tagline?: string | null;
    avatarSeed?: string | null;
    personalityPresetId?: string | null;
  } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.model !== undefined) data.model = body.model;
  if (body.allowedTools !== undefined) data.allowedTools = body.allowedTools;
  if (body.pluginConfig !== undefined) data.pluginConfig = body.pluginConfig;
  if (body.greetingMessage !== undefined) data.greetingMessage = body.greetingMessage;
  if (body.tagline !== undefined) data.tagline = body.tagline;
  if (body.avatarSeed !== undefined) data.avatarSeed = body.avatarSeed;
  if (body.personalityPresetId !== undefined) data.personalityPresetId = body.personalityPresetId;

  const agent = await updateAgent(agentId, data);

  if (data.name !== undefined || data.tagline !== undefined) {
    writeIdentityFile(agentId, {
      name: agent.name,
      tagline: agent.tagline,
    });
  }

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
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Forbidden" }, { status: 403 });
  }

  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
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
