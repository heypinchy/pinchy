import { NextResponse, after } from "next/server";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { withAuth, withAdmin } from "@/lib/api-auth";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  agents,
  agentConnectionPermissions,
  agentMcpToolPermissions,
  integrationConnections,
} from "@/db/schema";
import { getTemplate, generateAgentsMd } from "@/lib/agent-templates";
import {
  applyRecommendedTools,
  type McpConnectionInfo,
} from "@/lib/agent-templates/recommended-tools";
import type { McpIntegrationData } from "@/lib/integrations/types";
import { isMcpEnabled } from "@/lib/feature-flags";
import { getPersonalityPreset, resolveGreetingMessage } from "@/lib/personality-presets";
import { generateAvatarSeed } from "@/lib/avatar";
import { AGENT_NAME_MAX_LENGTH } from "@/lib/agents";
import { validateAllowedPaths } from "@/lib/path-validation";
import { validatePinchyWebConfig, pluginConfigSchema } from "@/lib/domain-validation";
import { parseRequestBody } from "@/lib/api-validation";
import {
  ensureWorkspace,
  writeWorkspaceFile,
  writeWorkspaceFileInternal,
  writeIdentityFile,
} from "@/lib/workspace";
import { getContextForAgent } from "@/lib/context-sync";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { waitForAgentInRuntime } from "@/lib/wait-for-agent-in-runtime";
import { getOpenClawClient } from "@/server/openclaw-client";
import { getSetting } from "@/lib/settings";
import { type ProviderName } from "@/lib/providers";
import { getDefaultModel } from "@/lib/provider-models";
import { resolveModelForTemplate, TemplateCapabilityUnavailableError } from "@/lib/model-resolver";
import { appendAuditLog } from "@/lib/audit";
import { deferAuditLog } from "@/lib/audit-deferred";
import { getVisibleAgents } from "@/lib/visible-agents";
import { validateOdooTemplate } from "@/lib/integrations/odoo-template-validation";
import { detectEmailOperations } from "@/lib/tool-registry";

const createAgentSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(AGENT_NAME_MAX_LENGTH)
    .refine((v) => v.trim().length > 0, "Name is required"),
  templateId: z.string().min(1),
  tagline: z.string().nullish(),
  pluginConfig: pluginConfigSchema.nullish(),
  connectionId: z.string().nullish(),
  defaultAllowedTools: z.array(z.string()).optional(),
});

export const GET = withAuth(async (_req, _ctx, session) => {
  const visibleAgents = await getVisibleAgents(session.user.id!, session.user.role ?? "member");
  return NextResponse.json(visibleAgents);
});

export const POST = withAdmin(async (request, _ctx, session) => {
  const parsed = await parseRequestBody(createAgentSchema, request);
  if ("error" in parsed) return parsed.error;
  const { name, templateId, tagline, pluginConfig, connectionId, defaultAllowedTools } =
    parsed.data;

  const template = getTemplate(templateId);
  if (!template) {
    return NextResponse.json({ error: `Unknown template: ${templateId}` }, { status: 400 });
  }

  // Validate pinchy-web domain lists (parity with PATCH — agents created with
  // a knowledge-base template may carry a pinchy-web block in pluginConfig
  // alongside pinchy-files.allowed_paths).
  const pluginConfigError = validatePinchyWebConfig(pluginConfig);
  if (pluginConfigError) {
    return NextResponse.json({ error: pluginConfigError }, { status: 400 });
  }

  // Only file-access plugin requires directory selection
  if (template.pluginId === "pinchy-files") {
    const paths = pluginConfig?.["pinchy-files"]?.allowed_paths;
    if (!paths || paths.length === 0) {
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

  // Email templates require a connection
  if (template.requiresEmailConnection && !connectionId) {
    return NextResponse.json(
      { error: "An email connection is required for this template" },
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
        await appendAuditLog({
          actorType: "user",
          actorId: session.user.id!,
          eventType: "agent.created",
          outcome: "failure",
          detail: {
            templateId,
            missingCapabilities: err.missingCapabilities,
            provider: err.provider,
          },
        });
        return NextResponse.json(
          {
            error: "template_capability_unavailable",
            message: err.message,
            missingCapabilities: err.missingCapabilities,
            docsUrl: err.docsUrl,
          },
          { status: 422 }
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

  const mergedAllowedTools = [
    ...new Set([...(template.allowedTools ?? []), ...(defaultAllowedTools ?? [])]),
  ];

  // Skills from the template seed the agent's allowlist. Templates without
  // defaultSkills get an empty list — same shape as a pre-migration agent.
  // See master issue #543.
  const templateSkills = [...new Set(template.defaultSkills ?? [])];

  const [agent] = await db
    .insert(agents)
    .values({
      name,
      model,
      templateId,
      pluginConfig: template.pluginId && pluginConfig ? pluginConfig : null,
      ownerId: session.user.id,
      allowedTools: mergedAllowedTools,
      skills: templateSkills,
      tagline: tagline || template.defaultTagline || null,
      avatarSeed: generateAvatarSeed(),
      personalityPresetId: template.defaultPersonality,
      greetingMessage: resolveGreetingMessage(
        template.defaultGreetingMessage ?? preset?.greetingMessage ?? "Hi {user}. How can I help?",
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
        skills: templateSkills,
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

        deferAuditLog({
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
        });
      }
    }
  }

  // Auto-configure email permissions when template requires email connection
  if (template.requiresEmailConnection && connectionId) {
    const emailOps = detectEmailOperations(template.allowedTools);

    if (emailOps.length > 0) {
      const permissionRows = emailOps.map((op) => ({
        agentId: agent.id,
        connectionId,
        model: "email",
        operation: op,
      }));

      await db.insert(agentConnectionPermissions).values(permissionRows);

      deferAuditLog({
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
      });
    }
  }

  // Non-blocking warnings surfaced to the client (shown as a toast). Today the
  // only producer is the MCP auto-grant below.
  const warnings: string[] = [];

  // Auto-grant recommended MCP tools when the template declares them.
  // Mirrors the Odoo/email auto-config above: the chosen template IS the
  // deliberate selection, so we grant only the wish-listed tools that an
  // active matching connection actually advertises — `applyRecommendedTools`
  // silently skips the rest, so this never grants the whole catalogue
  // (least-privilege; the admin tunes it later in the Permissions tab).
  //
  // Without this an MCP agent (e.g. GitHub PR Reviewer) was created with zero
  // tool permissions: the model saw no tools and improvised "no MCP connected".
  if (isMcpEnabled() && template.recommendedTools && template.recommendedTools.length > 0) {
    const mcpConnRows = await db
      .select({ id: integrationConnections.id, data: integrationConnections.data })
      .from(integrationConnections)
      .where(
        and(eq(integrationConnections.type, "mcp"), eq(integrationConnections.status, "active"))
      );

    const mcpConnections: McpConnectionInfo[] = mcpConnRows.flatMap((row) => {
      const data = row.data as McpIntegrationData | null;
      if (!data?.preset) return [];
      return [{ id: row.id, preset: data.preset, tools: (data.tools ?? []).map((t) => t.name) }];
    });

    const { grants, skipped } = applyRecommendedTools(template.recommendedTools, mcpConnections);

    // Surface skipped tools. `applyRecommendedTools` skips silently by design
    // (§4.3 — never crash on a renamed provider tool), but a silent skip means
    // the agent ships unable to do its job with no signal. That is exactly the
    // 2026-06 GitHub-rename breakage. Turn the silent skip into a visible,
    // actionable warning so a stale template name can never again look like a
    // working agent.
    if (skipped.length > 0) {
      const names = skipped.map((s) => s.tool).join(", ");
      warnings.push(
        grants.length === 0
          ? `None of this template's recommended tools (${names}) could be connected from your integration — they may have been renamed on the MCP server. Open the agent's Permissions tab to grant tools manually.`
          : `Some recommended tools couldn't be connected from your integration (${names}); the rest were granted. Review the agent's Permissions tab.`
      );
    }

    if (grants.length > 0) {
      await db.insert(agentMcpToolPermissions).values(
        grants.map((g) => ({
          agentId: agent.id,
          connectionId: g.connectionId,
          toolName: g.toolName,
        }))
      );

      deferAuditLog({
        actorType: "user",
        actorId: session.user.id!,
        eventType: "config.changed",
        resource: `agent:${agent.id}`,
        detail: {
          action: "agent_integration_permissions_auto_configured",
          agentId: agent.id,
          mcpTools: grants.map((g) => ({ connectionId: g.connectionId, tool: g.toolName })),
        },
        outcome: "success",
      });
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

  // Wait until OC's runtime has the new agent visible in `agents.list`.
  // Pinchy's regenerate is fire-and-forget (`pushConfigInBackground`) and OC
  // applies the hot reload asynchronously; without this gate the first
  // dispatch after POST /api/agents can race the reload and fail with
  // `invalid agent params: unknown agent id`. Best-effort with a 5 s cap so
  // we don't block the interactive save flow if OC is restarting.
  let client = null;
  try {
    client = getOpenClawClient();
  } catch {
    // OC client not initialised (rare in tests / pre-setup). Skip the wait.
  }
  await waitForAgentInRuntime(client, agent.id);

  revalidatePath("/", "layout");

  return NextResponse.json(warnings.length > 0 ? { ...agent, warnings } : agent, { status: 201 });
});
