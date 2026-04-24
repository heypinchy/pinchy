import { eq } from "drizzle-orm";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { deleteOAuthSettings } from "@/lib/integrations/oauth-settings";

type IntegrationConnection = typeof integrationConnections.$inferSelect;

export async function finalizeIntegrationDeletion(params: {
  actorId: string;
  connection: IntegrationConnection;
  detachedAgents: { id: string; name: string }[];
}): Promise<void> {
  const { actorId, connection, detachedAgents } = params;

  if (connection.type === "google") {
    // Called after the connection has already been deleted, so this query
    // returns zero rows only if no other Google connections remain.
    const remaining = await db
      .select({ id: integrationConnections.id })
      .from(integrationConnections)
      .where(eq(integrationConnections.type, "google"));
    if (remaining.length === 0) {
      await deleteOAuthSettings("google");
    }
  }

  try {
    await regenerateOpenClawConfig();
  } catch (err) {
    console.error("regenerateOpenClawConfig failed after integration delete", err);
  }

  const detail =
    detachedAgents.length > 0
      ? {
          action: "integration_deleted_with_permissions" as const,
          type: connection.type,
          name: connection.name,
          detachedAgents,
        }
      : {
          action: "integration_deleted" as const,
          type: connection.type,
          name: connection.name,
        };

  await appendAuditLog({
    actorType: "user",
    actorId,
    eventType: "config.changed",
    resource: `integration:${connection.id}`,
    outcome: "success",
    detail,
  }).catch((err) => console.error("audit append failed", err));
}
