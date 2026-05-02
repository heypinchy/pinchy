import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/encryption";
import { appendAuditLog } from "@/lib/audit";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { maskConnectionCredentials } from "@/lib/integrations/mask-credentials";
import { deleteOAuthSettings } from "@/lib/integrations/oauth-settings";
import { z } from "zod";

const baseUpdateSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
});

const credentialSchemas: Record<string, z.ZodType> = {
  odoo: odooCredentialsSchema,
  "web-search": z.object({ apiKey: z.string().min(1) }).strict(),
};

type RouteContext = { params: Promise<{ connectionId: string }> };

export const GET = withAdmin<RouteContext>(async (_req, { params }) => {
  const { connectionId } = await params;
  const [connection] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!connection) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  return NextResponse.json({
    ...connection,
    credentials: maskConnectionCredentials(connection.type, connection.credentials, decrypt),
  });
});

export const PATCH = withAdmin<RouteContext>(async (request, { params }, session) => {
  const { connectionId } = await params;

  // Load existing connection
  const [existing] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!existing) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  const body = await request.json();

  // Validate base fields (name, description)
  const baseParsed = baseUpdateSchema.safeParse(body);
  if (!baseParsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: baseParsed.error.flatten() },
      { status: 400 }
    );
  }

  // Validate credentials based on connection type
  const rawCredentials = body.credentials;
  let parsedCredentials: Record<string, unknown> | undefined;
  if (rawCredentials !== undefined) {
    const credSchema = credentialSchemas[existing.type];
    if (!credSchema) {
      return NextResponse.json(
        { error: `Unknown connection type: ${existing.type}` },
        { status: 400 }
      );
    }
    const credResult = credSchema.safeParse(rawCredentials);
    if (!credResult.success) {
      return NextResponse.json(
        { error: "Validation failed", details: credResult.error.flatten() },
        { status: 400 }
      );
    }
    parsedCredentials = credResult.data as Record<string, unknown>;
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (baseParsed.data.name !== undefined) {
    updateData.name = baseParsed.data.name;
    if (baseParsed.data.name !== existing.name) {
      changes.name = { from: existing.name, to: baseParsed.data.name };
    }
  }
  if (baseParsed.data.description !== undefined) {
    updateData.description = baseParsed.data.description;
    if (baseParsed.data.description !== existing.description) {
      changes.description = { from: existing.description, to: baseParsed.data.description };
    }
  }
  if (parsedCredentials !== undefined) {
    if (existing.type === "odoo" && "url" in parsedCredentials) {
      const urlCheck = validateExternalUrl(parsedCredentials.url as string);
      if (!urlCheck.valid) {
        return NextResponse.json({ error: urlCheck.error }, { status: 400 });
      }
    }
    updateData.credentials = encrypt(JSON.stringify(parsedCredentials));
    changes.credentials = { from: "[redacted]", to: "[redacted]" };
  }

  const [updated] = await db
    .update(integrationConnections)
    .set(updateData)
    .where(eq(integrationConnections.id, connectionId))
    .returning();

  if (Object.keys(changes).length > 0) {
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      resource: `integration:${connectionId}`,
      detail: { action: "integration_updated", id: connectionId, changes },
      outcome: "success",
    });
  }

  return NextResponse.json({
    ...updated,
    credentials: maskConnectionCredentials(updated.type, updated.credentials, decrypt),
  });
});

export const DELETE = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { connectionId } = await params;

  // Load connection for audit log (need name + type before deletion)
  const [existing] = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));

  if (!existing) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId));

  // Clear OAuth settings when the last Google connection is removed
  if (existing.type === "google") {
    const remainingGoogle = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.type, "google"));
    if (remainingGoogle.length === 0) {
      await deleteOAuthSettings("google");
    }
  }

  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "config.changed",
    resource: `integration:${connectionId}`,
    detail: { action: "integration_deleted", type: existing.type, name: existing.name },
    outcome: "success",
  });

  return NextResponse.json({ success: true });
});
