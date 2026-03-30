import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { OdooClient } from "odoo-node";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { decrypt } from "@/lib/encryption";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { appendAuditLog } from "@/lib/audit";

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function POST(request: NextRequest, { params }: RouteContext) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

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

    const creds = parsed.data;
    const client = new OdooClient({
      url: creds.url,
      db: creds.db,
      uid: creds.uid,
      apiKey: creds.apiKey,
    });

    // Fetch all models
    const allModels = await client.models();

    // Fetch fields for each model — only commonly used Odoo modules to keep it manageable
    const RELEVANT_PREFIXES = [
      "sale.",
      "purchase.",
      "stock.",
      "product.",
      "res.partner",
      "res.company",
      "account.",
      "crm.",
      "mail.",
      "hr.",
      "helpdesk.",
      "note.",
    ];

    const relevantModels = allModels.filter((m) =>
      RELEVANT_PREFIXES.some((prefix) => m.model.startsWith(prefix))
    );

    const models = await Promise.all(
      relevantModels.map(async (m) => {
        try {
          const fields = await client.fields(m.model);
          return { model: m.model, name: m.name, fields };
        } catch {
          // Some models may not be accessible — skip them
          return { model: m.model, name: m.name, fields: [] };
        }
      })
    );

    const lastSyncAt = new Date().toISOString();
    const data = { models, lastSyncAt };

    await db
      .update(integrationConnections)
      .set({ data, updatedAt: new Date() })
      .where(eq(integrationConnections.id, connectionId));

    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      detail: {
        action: "integration_schema_synced",
        id: connectionId,
        name: connection.name,
        modelCount: models.length,
      },
    }).catch(() => {});

    return NextResponse.json({
      success: true,
      models: models.length,
      lastSyncAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Sync failed";
    return NextResponse.json({ success: false, error: message }, { status: 200 });
  }
}
