import { NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { withAuth } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { validateOdooTemplate } from "@/lib/integrations/odoo-template-validation";
import { getConnectionModels } from "@/lib/integrations/odoo-connection-models";
import { getActiveMcpPresets } from "@/lib/integrations/mcp-connections";
import { getSetting } from "@/lib/settings";
import { type ProviderName } from "@/lib/providers";
import { resolveModelForTemplate, TemplateCapabilityUnavailableError } from "@/lib/model-resolver";
import { EMAIL_CONNECTION_TYPES } from "@/lib/integrations/oauth-providers";
import { isMcpEnabled } from "@/lib/feature-flags";

export const GET = withAuth(async () => {
  const odooConnections = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(eq(integrationConnections.type, "odoo"))
    .limit(1);

  const hasOdooConnection = odooConnections.length > 0;

  const emailConnections = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(inArray(integrationConnections.type, [...EMAIL_CONNECTION_TYPES]))
    .limit(1);

  const hasEmailConnection = emailConnections.length > 0;

  // Load connection models for Odoo availability check
  const connectionModels = hasOdooConnection ? await getConnectionModels() : null;

  // Determine active provider for capability-based template filtering
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;

  // MCP templates are gated on the feature flag AND on a per-preset
  // connection check. When the flag is off, the entire MCP surface must be
  // absent (D3) — filter those templates out entirely rather than merely
  // marking them unavailable, matching how every other MCP route/UI surface
  // behaves when `isMcpEnabled()` is false.
  const mcpEnabled = isMcpEnabled();
  const templateEntries = mcpEnabled
    ? Object.entries(AGENT_TEMPLATES)
    : Object.entries(AGENT_TEMPLATES).filter(([, template]) => !template.requiresMcpConnection);

  // A template that needs the `linear` preset shouldn't look creatable when
  // no Linear connection is active (the "Triage talks about Linear with
  // nothing connected" trap) — unlike Odoo/email, this check is per-preset,
  // not a single boolean, so it's driven by `getActiveMcpPresets()`.
  const connectedMcpPresets = mcpEnabled ? await getActiveMcpPresets() : new Set<string>();

  // Build templates with both Odoo and capability availability
  const templates = await Promise.all(
    templateEntries.map(async ([id, template]) => {
      let available = true;
      let unavailableReason: "no-connection" | "missing-modules" | null = null;

      if (template.requiresEmailConnection && !hasEmailConnection) {
        available = false;
        unavailableReason = "no-connection";
      } else if (template.requiresOdooConnection && !hasOdooConnection) {
        available = false;
        unavailableReason = "no-connection";
      } else if (
        template.requiresMcpConnection &&
        !connectedMcpPresets.has(template.requiresMcpConnection)
      ) {
        available = false;
        unavailableReason = "no-connection";
      } else if (template.odooConfig && connectionModels) {
        const validation = validateOdooTemplate(template.odooConfig, connectionModels);
        available = validation.valid;
        if (!validation.valid) unavailableReason = "missing-modules";
      }

      // Check model capability availability
      let disabled = false;
      let disabledReason: string | undefined;

      if (template.modelHint && defaultProvider) {
        try {
          await resolveModelForTemplate({ hint: template.modelHint, provider: defaultProvider });
        } catch (err) {
          if (err instanceof TemplateCapabilityUnavailableError) {
            disabled = true;
            disabledReason = `Requires ${err.missingCapabilities.join(", ")}. Your provider "${defaultProvider}" has no matching model installed. → Install a model`;
          }
        }
      }

      return {
        id,
        name: template.name,
        description: template.description,
        requiresDirectories: template.pluginId === "pinchy-files",
        requiresOdooConnection: template.requiresOdooConnection ?? false,
        requiresEmailConnection: template.requiresEmailConnection ?? false,
        // Preset string (not a boolean, unlike its Odoo/email siblings) —
        // MCP has 8 presets, so the picker needs to know WHICH one is
        // missing, not just that "some" connection is missing.
        requiresMcpConnection: template.requiresMcpConnection ?? null,
        requiresWeb: template.pluginId === "pinchy-web",
        odooAccessLevel: template.odooConfig?.accessLevel,
        defaultTagline: template.defaultTagline,
        available,
        unavailableReason,
        disabled,
        disabledReason,
        iconName: template.iconName,
      };
    })
  );

  return NextResponse.json({ templates });
});
