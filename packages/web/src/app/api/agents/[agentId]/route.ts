import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { eq, inArray } from "drizzle-orm";
import { updateAgent, deleteAgent, AgentRuntimeUpdateError } from "@/lib/agents";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { getAgentWithAccess, requireAgentWriteAccess } from "@/lib/agent-access";
import { appendAuditLog, safeProviderError } from "@/lib/audit";
import type { UpdateDetail } from "@/lib/audit";
import { isEnterprise } from "@/lib/enterprise";
import { writeIdentityFile } from "@/lib/workspace";
import { db } from "@/db";
import { agentGroups, groups, type AgentPluginConfig } from "@/db/schema";
import type { AgentVisibility } from "@/db/enums";
import { getAgentGroupIds } from "@/lib/groups";
import { recalculateTelegramAllowStores } from "@/lib/telegram-allow-store";
import { validatePinchyWebConfig } from "@/lib/domain-validation";
import { parseRequestBody } from "@/lib/api-validation";
import { validateAgentModel } from "@/lib/agent-model-validation";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { updateAgentSchema } from "@/lib/schemas/agents";

type RouteContext = { params: Promise<{ agentId: string }> };

/** What an `agent.updated` row carries, success or failure. */
type AgentUpdateDetail = UpdateDetail & {
  allowedGroups?: {
    added: { id: string; name: string }[];
    removed: { id: string; name: string }[];
  };
};

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

  // pluginConfig is a permission, not a preference. `pinchy-files.
  // allowed_paths` inside it is the allowlist that scopes the agent's file
  // tools, its knowledge-base retrieval filter, and the browser-facing
  // `GET /api/agents/[id]/workspace-file` route — which consults that list and
  // nothing else, so a grant alone is a read, with no tool and no group
  // membership needed. `pluginConfigSchema` confines the VALUE to /data, but
  // /data is every corpus: a member who may still write `["/data/hr"]` onto
  // their own seeded personal agent reads HR's documents. Same gate as
  // allowedTools, and it costs the UI nothing — the Permissions tab that emits
  // this field renders only for `isAdmin && !isPersonal`, and every request it
  // sends carries allowedTools anyway.
  if (body.pluginConfig !== undefined && session.user.role !== "admin") {
    return NextResponse.json({ error: "Only admins can change permissions" }, { status: 403 });
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

  // A model change must point at a model of a CONFIGURED provider — anything
  // else leaves the agent unable to chat (no API key for the provider). An
  // unchanged model is not validated so updates to other fields keep working
  // for agents carrying a legacy model of a since-disconnected provider.
  if (body.model !== undefined && body.model !== existingAgent.model) {
    const modelError = await validateAgentModel(body.model);
    if (modelError) {
      return NextResponse.json({ error: modelError }, { status: 400 });
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
    starterPrompts?: string[];
    avatarSeed?: string | null;
    personalityPresetId?: string | null;
    visibility?: AgentVisibility;
  } = {};
  if (body.name !== undefined) data.name = body.name;
  if (body.model !== undefined) data.model = body.model;
  if (body.allowedTools !== undefined) data.allowedTools = body.allowedTools;
  if (body.pluginConfig !== undefined) data.pluginConfig = body.pluginConfig;
  if (body.greetingMessage !== undefined) data.greetingMessage = body.greetingMessage;
  if (body.tagline !== undefined) data.tagline = body.tagline;
  if (body.starterPrompts !== undefined) data.starterPrompts = body.starterPrompts;
  if (body.avatarSeed !== undefined) data.avatarSeed = body.avatarSeed;
  if (body.personalityPresetId !== undefined) data.personalityPresetId = body.personalityPresetId;
  if (body.visibility !== undefined) data.visibility = body.visibility;

  // Build from/to changes diff.
  //
  // Derived from `data` and `existingAgent` alone, so it is built BEFORE the
  // write — a regeneration failure still changed the row, and the audit entry
  // for that change needs this diff (see the catch below).
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
  // starterPrompts is an array — compare by content, not reference, or a
  // general-tab save would log a spurious "change" every time (#570).
  if (data.starterPrompts !== undefined) {
    const oldPrompts = existingAgent.starterPrompts ?? [];
    if (JSON.stringify(oldPrompts) !== JSON.stringify(data.starterPrompts)) {
      changes.starterPrompts = { from: oldPrompts, to: data.starterPrompts };
    }
  }
  if (data.pluginConfig !== undefined) {
    const oldConfig = existingAgent.pluginConfig ?? null;
    const newConfig = data.pluginConfig ?? null;
    if (JSON.stringify(oldConfig) !== JSON.stringify(newConfig)) {
      changes.pluginConfig = { from: oldConfig, to: newConfig };
    }
  }

  // updateAgent writes the row and THEN calls regenerateOpenClawConfig(); the
  // two are not in a transaction. Letting the throw escape hands Next.js a 500
  // whose body carries no `error` field, and the client can only say "Failed to
  // save some settings" — which is exactly how #1095 stayed invisible for two
  // days: the cause (EACCES on a root-owned TOOLS.md) lived solely in the
  // container log.
  //
  // The two failures need opposite answers, and only `updateAgent` knows which
  // one happened — hence the error type rather than an errno guess here:
  //
  //   AgentRuntimeUpdateError → the row IS written, the runtime is stale. Say
  //     so, and audit it: a state change with no audit entry is what AGENTS.md
  //     forbids, and `outcome: "failure"` exists for precisely this shape.
  //   anything else → the write itself failed, nothing persisted. Claiming it
  //     was saved would stop the user retrying a change that never landed.
  /**
   * The answer a failed config push owes the caller.
   *
   * TWO sites in this handler push the runtime config — `updateAgent` for the
   * fields it owns, and the tail of this handler for `allowedTools` /
   * `pluginConfig`. They share this so they cannot drift into two different
   * stories about the same failure, and so the second one cannot be forgotten
   * the way it was: it went in unguarded, which left a permission change — the
   * exact change #1095 broke — answering a blank Next.js 500.
   *
   * `detail` is null when there is nothing auditable to record.
   */
  function runtimeUpdateFailed(err: unknown, detail: AgentUpdateDetail | null): NextResponse {
    const cause = err instanceof Error ? err.message : String(err);
    console.error(`[agents] config regeneration failed for agent ${agentId}:`, err);
    if (detail) {
      after(() =>
        appendAuditLog({
          actorType: "user",
          actorId: session.user.id!,
          eventType: "agent.updated",
          resource: `agent:${agentId}`,
          // safeProviderError, not the raw string: an uncapped field would
          // trip truncateDetail, which replaces the WHOLE detail with a
          // summary blob rather than trimming the offender — taking
          // `changes` with it, on the one row whose value is recording what
          // changed. It also scrubs addresses, and this path exists because
          // of TOOLS.md, the file carrying an agent's mailbox context.
          detail: { ...detail, runtimeUpdate: { applied: false, error: safeProviderError(cause) } },
          outcome: "failure",
        })
      );
    }
    return NextResponse.json(
      { error: `Settings were saved, but the agent runtime was not updated: ${cause}` },
      { status: 500 }
    );
  }

  let agent: typeof existingAgent;
  try {
    agent = Object.keys(data).length > 0 ? await updateAgent(agentId, data) : existingAgent;
  } catch (err) {
    if (err instanceof AgentRuntimeUpdateError) {
      return runtimeUpdateFailed(err, Object.keys(changes).length > 0 ? { changes } : null);
    }

    const cause = err instanceof Error ? err.message : String(err);
    console.error(`[agents] update failed for agent ${agentId}:`, err);
    return NextResponse.json({ error: `Could not update the agent: ${cause}` }, { status: 500 });
  }

  // Capture old group IDs for audit diff (BEFORE delete/insert)
  const oldGroupIds =
    body.groupIds !== undefined && session.user.role === "admin"
      ? await getAgentGroupIds(agentId)
      : [];

  // Update group assignments if provided (zod already validated string[]).
  // Atomic replace: the wipe and the re-insert must commit or roll back
  // together. As two standalone statements, an insert failure (I/O error, a
  // group deleted in the validation→insert window) would leave a restricted
  // agent stripped of every group with none re-added — silent access loss.
  // Mirrors users/[userId]/groups and groups/[groupId]/members.
  if (body.groupIds !== undefined && session.user.role === "admin") {
    await db.transaction(async (tx) => {
      await tx.delete(agentGroups).where(eq(agentGroups.agentId, agentId));
      if (body.groupIds!.length > 0) {
        await tx
          .insert(agentGroups)
          .values(body.groupIds!.map((groupId: string) => ({ agentId, groupId })));
      }
    });
  }

  if (data.name !== undefined || data.tagline !== undefined) {
    writeIdentityFile(agentId, {
      name: agent.name,
      tagline: agent.tagline,
    });
  }

  // Build audit detail with group diffs
  const auditDetail: AgentUpdateDetail = { changes };

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

  const hasAuditableChange = Object.keys(changes).length > 0 || Boolean(auditDetail.allowedGroups);

  // Recalculate Telegram allow-from stores when visibility or groups change.
  // Above the push, where it has always run: the rows it mirrors are already
  // committed, so a failed push must not skip it and leave the store enforcing
  // an access rule the database no longer has.
  if (body.visibility !== undefined || body.groupIds !== undefined) {
    await recalculateTelegramAllowStores();
  }

  // Rebuild OpenClaw config when tool permissions or plugin config change — these
  // fields affect the generated openclaw.json (e.g. write_paths for pinchy_write).
  //
  // Guarded like the push inside updateAgent, and for the same reason: this is
  // the one a PERMISSION change rides on, which is the change #1095 actually
  // broke. Unguarded it escaped as a blank 500.
  //
  // Ordered BEFORE the audit registration, which is the other half of the bug.
  // `after()` cannot be cancelled once queued, so a success row registered
  // first would still be written after this fails — one request leaving two
  // rows that disagree, with the wrong one claiming `outcome: "success"`.
  if (data.allowedTools !== undefined || data.pluginConfig !== undefined) {
    try {
      await regenerateOpenClawConfig();
    } catch (err) {
      return runtimeUpdateFailed(err, hasAuditableChange ? auditDetail : null);
    }
  }

  if (hasAuditableChange) {
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

  // Registered the instant the soft-delete commits — NOT after deleteAgent
  // returns. Its cleanup tail runs outside that transaction and can throw; see
  // deleteAgent for why awaiting it first loses the record of a deletion that
  // genuinely happened.
  await deleteAgent(agentId, () =>
    after(() =>
      appendAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "agent.deleted",
        resource: `agent:${agentId}`,
        detail: { name: agent.name },
        outcome: "success",
      })
    )
  );

  revalidatePath("/", "layout");

  return NextResponse.json({ success: true });
});
