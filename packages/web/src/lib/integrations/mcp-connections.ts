import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import type { McpIntegrationData } from "@/lib/integrations/types";

/**
 * The set of MCP preset ids ("github", "linear", …) that currently have an
 * active connection. Used to gate MCP-backed agent templates: a template that
 * needs the `linear` preset shouldn't look creatable when no Linear connection
 * exists (the "Triage talks about Linear with nothing connected" trap).
 */
export async function getActiveMcpPresets(): Promise<Set<string>> {
  const rows = await db
    .select({ data: integrationConnections.data })
    .from(integrationConnections)
    .where(
      and(eq(integrationConnections.type, "mcp"), eq(integrationConnections.status, "active"))
    );

  const presets = new Set<string>();
  for (const row of rows) {
    const preset = (row.data as McpIntegrationData | null)?.preset;
    if (preset) presets.add(preset);
  }
  return presets;
}
