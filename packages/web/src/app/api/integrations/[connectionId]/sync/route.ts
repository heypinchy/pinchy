import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { deferAuditLog } from "@/lib/audit-deferred";
import { fetchOdooSchema } from "@/lib/integrations/odoo-sync";
import { validateExternalUrl } from "@/lib/integrations/url-validation";

type RouteContext = { params: Promise<{ connectionId: string }> };

export const POST = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { connectionId } = await params;

  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  try {
    const decrypted = JSON.parse(decrypt(connection.credentials));
    const parsed = odooCredentialsSchema.safeParse(decrypted);
    if (!parsed.success) {
      return NextResponse.json(
        { success: false, error: "Invalid credentials format" },
        { status: 200 }
      );
    }

    const urlCheck = validateExternalUrl(parsed.data.url);
    if (!urlCheck.valid) {
      return NextResponse.json({ success: false, error: urlCheck.error }, { status: 200 });
    }

    const result = await fetchOdooSchema(parsed.data);
    if (!result.success) {
      return NextResponse.json(result);
    }

    await db
      .update(integrationConnections)
      .set({ data: result.data, updatedAt: new Date() })
      .where(eq(integrationConnections.id, connectionId));

    deferAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      resource: `integration:${connectionId}`,
      detail: {
        action: "integration_schema_synced",
        id: connectionId,
        name: connection.name,
        modelCount: result.models,
      },
      outcome: "success",
    });

    return NextResponse.json({
      success: true,
      models: result.models,
      lastSyncAt: result.lastSyncAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ success: false, error: message }, { status: 200 });
  }
});
