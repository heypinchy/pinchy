import { NextRequest, NextResponse, after } from "next/server";
import { headers } from "next/headers";
import { revalidatePath } from "next/cache";
import { getSession } from "@/lib/auth";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { agents, agentConnectionPermissions, integrationConnections } from "@/db/schema";
import { getTemplate, generateAgentsMd } from "@/lib/agent-templates";
import { getPersonalityPreset, resolveGreetingMessage } from "@/lib/personality-presets";
import { generateAvatarSeed } from "@/lib/avatar";
import { AGENT_NAME_MAX_LENGTH } from "@/lib/agents";
import { validateAllowedPaths } from "@/lib/path-validation";
import {
  ensureWorkspace,
  writeWorkspaceFile,
  writeWorkspaceFileInternal,
  writeIdentityFile,
} from "@/lib/workspace";
import { getContextForAgent } from "@/lib/context-sync";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { getSetting } from "@/lib/settings";
import { type ProviderName } from "@/lib/providers";
import { getDefaultModel } from "@/lib/provider-models";
import { resolveModelForTemplate, TemplateCapabilityUnavailableError } from "@/lib/model-resolver";
import { appendAuditLog } from "@/lib/audit";
import { getVisibleAgents } from "@/lib/visible-agents";
import { validateOdooTemplate } from "@/lib/integrations/odoo-template-validation";

export async function GET() {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const visibleAgents = await getVisibleAgents(session.user.id!, session.user.role ?? "member");
  return NextResponse.json(visibleAgents);
}

export async function POST(request: NextRequest) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const body = await request.json();
  const { name, templateId, tagline, pluginConfig, connectionId } = body;

  if (!name || typeof name !== "string") {
    return NextResponse.json({ error: "Name is required" }, { status: 400 });
  }

  if (name.length > AGENT_NAME_MAX_LENGTH) {
    return NextResponse.json(
      { error: `Name must be ${AGENT_NAME_MAX_LENGTH} characters or less` },
      { status: 400 }
    );
  }

  if (!templateId || typeof templateId !== "string") {
    return NextResponse.json({ error: "Template is required" }, { status: 400 });
  }

  const template = getTemplate(templateId);
  if (!template) {
    return NextResponse.json({ error: `Unknown template: ${templateId}` }, { status: 400 });
  }

  // Templates with pluginId require directory selection
  if (template.pluginId) {
    const paths = pluginConfig?.allowed_paths;
    if (!Array.isArray(paths) || paths.length === 0) {
      return NextResponse.json(
        { error: "At least one directory must be selected" },
        { status: 400 }
      );
    }
    try {
      validateAllowedPaths(paths);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Invalid paths";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  }

  // Odoo templates require a connection
  if (template.requiresOdooConnection && !connectionId) {
    return NextResponse.json(
      { error: "An Odoo connection is required for this template" },
      { status: 400 }
    );
  }

  // Resolve personality preset from template
  const preset = getPersonalityPreset(template.defaultPersonality);

  // Determine model: use template-aware resolver when modelHint is present,
  // fall back to provider default for templates without a hint (e.g. "custom").
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;

  let model: string;
  let modelSelectionSource: "template-hint" | "provider-default" = "provider-default";
  let modelSelectionReason: string;

  if (template.modelHint && defaultProvider) {
    try {
      const resolved = await resolveModelForTemplate({
        hint: template.modelHint,
        provider: defaultProvider,
      });
      model = resolved.model;
      modelSelectionReason = resolved.reason;
      modelSelectionSource = "template-hint";
    } catch (err) {
      if (err instanceof TemplateCapabilityUnavailableError) {
        return NextResponse.json(
          {
            error: "template_capability_unavailable",
            message: err.message,
            missingCapabilities: err.missingCapabilities,
            docsUrl: err.docsUrl,
          },
          { status: 400 }
        );
      }
      throw err;
    }
  } else {
    model = defaultProvider
      ? await getDefaultModel(defaultProvider)
      : "anthropic/claude-haiku-4-5-20251001";
    modelSelectionReason = `provider-default (${defaultProvider ?? "anthropic fallback"})`;
  }

  const [agent] = await db
    .insert(agents)
    .values({
      name,
      model,
      templateId,
      pluginConfig: template.pluginId && pluginConfig ? pluginConfig : null,
      ownerId: session.user.id,
      allowedTools: template.allowedTools,
      tagline: tagline || template.defaultTagline || null,
      avatarSeed: generateAvatarSeed(),
      personalityPresetId: template.defaultPersonality,
      greetingMessage: resolveGreetingMessage(
        template.defaultGreetingMessage ?? preset?.greetingMessage ?? null,
        name.trim()
      ),
    })
    .returning();

  after(() =>
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "agent.created",
      resource: `agent:${agent.id}`,
      detail: {
        name: agent.name,
        model: agent.model,
        templateId,
        modelSelection: {
          source: modelSelectionSource,
          hint: template.modelHint ?? null,
          reason: modelSelectionReason,
        },
      },
      outcome: "success",
    })
  );

  // Auto-configure Odoo permissions when template has odooConfig
  if (template.odooConfig && connectionId) {
    const connRows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));

    if (connRows.length > 0) {
      const connectionData = connRows[0].data as {
        models?: Array<{
          model: string;
          name: string;
          access?: { read: boolean; create: boolean; write: boolean; delete: boolean };
        }>;
      } | null;
      const models = connectionData?.models ?? [];

      const validation = validateOdooTemplate(template.odooConfig, models);

      if (validation.availableModels.length > 0) {
        const permissionRows = validation.availableModels.flatMap((m) =>
          m.operations.map((op) => ({
            agentId: agent.id,
            connectionId,
            model: m.model,
            operation: op,
          }))
        );

        await db.insert(agentConnectionPermissions).values(permissionRows);

        appendAuditLog({
          actorType: "user",
          actorId: session.user.id!,
          eventType: "config.changed",
          resource: `agent:${agent.id}`,
          detail: {
            action: "agent_integration_permissions_auto_configured",
            agentId: agent.id,
            connectionId,
            permissions: permissionRows.map((p) => ({ model: p.model, operation: p.operation })),
          },
          outcome: "success",
        }).catch(console.error);
      }
    }
  }

  // Create workspace with personality preset's SOUL.md
  ensureWorkspace(agent.id);
  writeWorkspaceFile(agent.id, "SOUL.md", preset?.soulMd ?? "");
  writeIdentityFile(agent.id, { name: agent.name, tagline: agent.tagline });
  const agentsMd = generateAgentsMd(
    template,
    template.pluginId && pluginConfig ? pluginConfig : undefined
  );
  if (agentsMd) {
    writeWorkspaceFile(agent.id, "AGENTS.md", agentsMd);
  }
  const context = await getContextForAgent({
    isPersonal: false,
    ownerId: session.user.id!,
  });
  writeWorkspaceFileInternal(agent.id, "USER.md", context);

  await regenerateOpenClawConfig();

  revalidatePath("/", "layout");

  return NextResponse.json(agent, { status: 201 });
}
