import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { updateAgent, deleteAgent, AGENT_NAME_MAX_LENGTH } from "@/lib/agents";
import { getSession } from "@/lib/auth";
import { getAgentWithAccess, assertAgentWriteAccess } from "@/lib/agent-access";
import { appendAuditLog } from "@/lib/audit";
import type { UpdateDetail } from "@/lib/audit";
import { isEnterprise } from "@/lib/enterprise";
import { writeIdentityFile } from "@/lib/workspace";
import { db } from "@/db";
import { agentGroups, groups } from "@/db/schema";
import { getAgentGroupIds } from "@/lib/groups";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";

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

  const groupIds = await getAgentGroupIds(agentId);
  return NextResponse.json({ ...agent, groupIds });
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

  // Only admins can change visibility (enterprise feature)
  if (body.visibility !== undefined) {
    if (session.user.role !== "admin") {
      return NextResponse.json({ error: "Only admins can change visibility" }, { status: 403 });
    }
    if (!(await isEnterprise())) {
      return NextResponse.json({ error: "Enterprise feature" }, { status: 403 });
    }
    if (!["all", "restricted"].includes(body.visibility)) {
      return NextResponse.json({ error: "Invalid visibility value" }, { status: 400 });
    }
    if (existingAgent.isPersonal) {
      return NextResponse.json(
        { error: "Cannot change visibility for personal agents" },
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
    visibility?: string;
  } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.model !== undefined) data.model = body.model;
  if (body.allowedTools !== undefined) data.allowedTools = body.allowedTools;
  if (body.pluginConfig !== undefined) data.pluginConfig = body.pluginConfig;
  if (body.greetingMessage !== undefined) data.greetingMessage = body.greetingMessage;
  if (body.tagline !== undefined) data.tagline = body.tagline;
  if (body.avatarSeed !== undefined) data.avatarSeed = body.avatarSeed;
  if (body.personalityPresetId !== undefined) data.personalityPresetId = body.personalityPresetId;
  if (body.visibility !== undefined) data.visibility = body.visibility;

  const agent = Object.keys(data).length > 0 ? await updateAgent(agentId, data) : existingAgent;

  // Build from/to changes diff
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  const diffFields = [
    "name",
    "model",
    "visibility",
    "greetingMessage",
    "tagline",
    "avatarSeed",
    "personalityPresetId",
  ] as const;
  for (const field of diffFields) {
    if (data[field] !== undefined && data[field] !== existingAgent[field]) {
      changes[field] = { from: existingAgent[field] ?? null, to: data[field] ?? null };
    }
  }
  if (data.allowedTools !== undefined) {
    const oldTools = existingAgent.allowedTools ?? [];
    if (JSON.stringify(oldTools) !== JSON.stringify(data.allowedTools)) {
      changes.allowedTools = { from: oldTools, to: data.allowedTools };
    }
  }

  // Capture old group IDs for audit diff (BEFORE delete/insert)
  const oldGroupIds =
    body.groupIds !== undefined && session.user.role === "admin"
      ? await getAgentGroupIds(agentId)
      : [];

  // Update group assignments if provided
  if (body.groupIds !== undefined && session.user.role === "admin") {
    if (
      !Array.isArray(body.groupIds) ||
      !body.groupIds.every((id: unknown) => typeof id === "string")
    ) {
      return NextResponse.json({ error: "groupIds must be an array of strings" }, { status: 400 });
    }
    await db.delete(agentGroups).where(eq(agentGroups.agentId, agentId));
    if (body.groupIds.length > 0) {
      await db
        .insert(agentGroups)
        .values(body.groupIds.map((groupId: string) => ({ agentId, groupId })));
    }
  }

  if (data.name !== undefined || data.tagline !== undefined) {
    writeIdentityFile(agentId, {
      name: agent.name,
      tagline: agent.tagline,
    });
  }

  // Build audit detail with group diffs
  const auditDetail: UpdateDetail & {
    allowedGroups?: {
      added: { id: string; name: string }[];
      removed: { id: string; name: string }[];
    };
  } = { changes };

  if (body.groupIds !== undefined && session.user.role === "admin") {
    const addedIds = body.groupIds.filter((id: string) => !oldGroupIds.includes(id));
    const removedIds = oldGroupIds.filter((id: string) => !body.groupIds.includes(id));
    if (addedIds.length > 0 || removedIds.length > 0) {
      const allGroupIds = [...new Set([...addedIds, ...removedIds])];
      const groupRows =
        allGroupIds.length > 0
          ? await db
              .select({ id: groups.id, name: groups.name })
              .from(groups)
              .where(inArray(groups.id, allGroupIds))
          : [];
      const nameMap = new Map(groupRows.map((g: { id: string; name: string }) => [g.id, g.name]));
      auditDetail.allowedGroups = {
        added: addedIds.map((id: string) => ({ id, name: nameMap.get(id) ?? id })),
        removed: removedIds.map((id: string) => ({ id, name: nameMap.get(id) ?? id })),
      };
    }
  }

  if (Object.keys(changes).length > 0 || auditDetail.allowedGroups) {
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "agent.updated",
      resource: `agent:${agentId}`,
      detail: auditDetail,
    }).catch(() => {});
  }

  // Recalculate Telegram allow-from stores when visibility or groups change
  if (body.visibility !== undefined || body.groupIds !== undefined) {
    await recalculateTelegramAllowStores();
  }

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
