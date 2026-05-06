import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { updateAgent, deleteAgent, AGENT_NAME_MAX_LENGTH } from "@/lib/agents";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { getAgentWithAccess, requireAgentWriteAccess } from "@/lib/agent-access";
import { appendAuditLog } from "@/lib/audit";
import type { UpdateDetail } from "@/lib/audit";
import { isEnterprise } from "@/lib/enterprise";
import { writeIdentityFile } from "@/lib/workspace";
import { db } from "@/db";
import { agentGroups, groups, type AgentPluginConfig } from "@/db/schema";
import { getAgentGroupIds } from "@/lib/groups";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { validatePinchyWebConfig, pluginConfigSchema } from "@/lib/domain-validation";
import { parseRequestBody } from "@/lib/api-validation";

const updateAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(AGENT_NAME_MAX_LENGTH)
    .refine((v) => v.trim().length > 0, "Name is required")
    .optional(),
  model: z.string().optional(),
  allowedTools: z.array(z.string()).optional(),
  pluginConfig: pluginConfigSchema.nullable().optional(),
  greetingMessage: z.string().min(1, "Greeting message cannot be empty").optional(),
  tagline: z.string().nullable().optional(),
  avatarSeed: z.string().nullable().optional(),
  personalityPresetId: z.string().nullable().optional(),
  visibility: z.enum(["all", "restricted"]).optional(),
  groupIds: z.array(z.string()).optional(),
});

type RouteContext = { params: Promise<{ agentId: string }> };

export const GET = withAuth<RouteContext>(async (_req, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  const groupIds = await getAgentGroupIds(agentId);
  return NextResponse.json({ ...agent, groupIds });
});

export const PATCH = withAuth<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  const existingAgentOrError = await getAgentWithAccess(
    agentId,
    session.user.id!,
    session.user.role
  );
  if (existingAgentOrError instanceof NextResponse) return existingAgentOrError;
  const existingAgent = existingAgentOrError;

  // Only admins or personal agent owners can modify agents
  const denied = requireAgentWriteAccess(existingAgent, session.user.id!, session.user.role);
  if (denied) return denied;

  const parsed = await parseRequestBody(updateAgentSchema, request);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;

  // Validate pluginConfig structure if provided (semantic validation beyond shape)
  const pluginConfigError = validatePinchyWebConfig(body.pluginConfig);
  if (pluginConfigError) {
    return NextResponse.json({ error: pluginConfigError }, { status: 400 });
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
    if (existingAgent.isPersonal) {
      return NextResponse.json(
        { error: "Cannot change visibility for personal agents" },
        { status: 400 }
      );
    }
  }

  // greetingMessage cannot be a whitespace-only string (zod min(1) catches empty,
  // but " " passes shape validation — reject to keep the field meaningful).
  if (
    body.greetingMessage !== undefined &&
    typeof body.greetingMessage === "string" &&
    body.greetingMessage.trim() === ""
  ) {
    return NextResponse.json({ error: "Greeting message cannot be empty" }, { status: 400 });
  }

  // Build update data
  const data: {
    name?: string;
    model?: string;
    allowedTools?: string[];
    pluginConfig?: AgentPluginConfig | null;
    greetingMessage?: string;
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
  if (data.pluginConfig !== undefined) {
    const oldConfig = existingAgent.pluginConfig ?? null;
    const newConfig = data.pluginConfig ?? null;
    if (JSON.stringify(oldConfig) !== JSON.stringify(newConfig)) {
      changes.pluginConfig = { from: oldConfig, to: newConfig };
    }
  }

  // Capture old group IDs for audit diff (BEFORE delete/insert)
  const oldGroupIds =
    body.groupIds !== undefined && session.user.role === "admin"
      ? await getAgentGroupIds(agentId)
      : [];

  // Update group assignments if provided (zod already validated string[])
  if (body.groupIds !== undefined && session.user.role === "admin") {
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
    const newIds = body.groupIds;
    const addedIds = newIds.filter((id: string) => !oldGroupIds.includes(id));
    const removedIds = oldGroupIds.filter((id: string) => !newIds.includes(id));
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
    after(() =>
      appendAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "agent.updated",
        resource: `agent:${agentId}`,
        detail: auditDetail,
        outcome: "success",
      })
    );
  }

  // Recalculate Telegram allow-from stores when visibility or groups change
  if (body.visibility !== undefined || body.groupIds !== undefined) {
    await recalculateTelegramAllowStores();
  }

  return NextResponse.json(agent);
});

export const DELETE = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;
  const agent = agentOrError;

  if (agent.isPersonal) {
    return NextResponse.json({ error: "Personal agents cannot be deleted" }, { status: 400 });
  }

  await deleteAgent(agentId);

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "agent.deleted",
      resource: `agent:${agentId}`,
      detail: { name: agent.name },
      outcome: "success",
    })
  );

  revalidatePath("/", "layout");

  return NextResponse.json({ success: true });
});
