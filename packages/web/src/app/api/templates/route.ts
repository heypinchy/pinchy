import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { auth } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { AGENT_TEMPLATES } from "@/lib/agent-templates";
import { validateOdooTemplate } from "@/lib/integrations/odoo-template-validation";
import { getConnectionModels } from "@/lib/integrations/odoo-connection-models";

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

  // Load connection models for availability check
  const connectionModels = hasOdooConnection ? await getConnectionModels() : null;

  const templates = Object.entries(AGENT_TEMPLATES)
    .filter(([, template]) => {
      if (template.requiresOdooConnection && !hasOdooConnection) {
        return false;
      }
      return true;
    })
    .map(([id, template]) => {
      let available = true;

      if (template.odooConfig && connectionModels) {
        const validation = validateOdooTemplate(template.odooConfig, connectionModels);
        available = validation.valid;
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
        iconName: template.iconName,
      };
    });

  return NextResponse.json({ templates });
}
