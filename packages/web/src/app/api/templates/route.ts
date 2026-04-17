import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { validateOdooTemplate } from "@/lib/integrations/odoo-template-validation";
import { getConnectionModels } from "@/lib/integrations/odoo-connection-models";
import { getSetting } from "@/lib/settings";
import { type ProviderName } from "@/lib/providers";
import { resolveModelForTemplate, TemplateCapabilityUnavailableError } from "@/lib/model-resolver";

export async function GET(request: NextRequest) {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const odooConnections = await db
    .select({ id: integrationConnections.id })
    .from(integrationConnections)
    .where(eq(integrationConnections.type, "odoo"))
    .limit(1);

  const hasOdooConnection = odooConnections.length > 0;

  // Load connection models for Odoo availability check
  const connectionModels = hasOdooConnection ? await getConnectionModels() : null;

  // Determine active provider for capability-based template filtering
  const defaultProvider = (await getSetting("default_provider")) as ProviderName | null;

  // Build templates with both Odoo and capability availability
  const templates = await Promise.all(
    Object.entries(AGENT_TEMPLATES).map(async ([id, template]) => {
      let available = true;
      let unavailableReason: "no-connection" | "missing-modules" | null = null;

      if (template.requiresOdooConnection && !hasOdooConnection) {
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
        requiresDirectories: template.pluginId !== null,
        requiresOdooConnection: template.requiresOdooConnection ?? false,
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
}
