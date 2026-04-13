import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/encryption";
import { appendAuditLog } from "@/lib/audit";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { maskConnectionCredentials } from "@/lib/integrations/mask-credentials";
import { z } from "zod";

const updateIntegrationSchema = z.object({
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  credentials: odooCredentialsSchema.optional(),
});

type RouteContext = { params: Promise<{ connectionId: string }> };

export async function GET(request: NextRequest, { params }: RouteContext) {
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

  return NextResponse.json({
    ...connection,
    credentials: maskConnectionCredentials(connection.type, connection.credentials, decrypt),
  });
}

export async function PATCH(request: NextRequest, { params }: RouteContext) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

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
  const parsed = updateIntegrationSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Validation failed", details: parsed.error.flatten() },
      { status: 400 }
    );
  }

  const updateData: Record<string, unknown> = { updatedAt: new Date() };
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (parsed.data.name !== undefined) {
    updateData.name = parsed.data.name;
    if (parsed.data.name !== existing.name) {
      changes.name = { from: existing.name, to: parsed.data.name };
    }
  }
  if (parsed.data.description !== undefined) {
    updateData.description = parsed.data.description;
    if (parsed.data.description !== existing.description) {
      changes.description = { from: existing.description, to: parsed.data.description };
    }
  }
  if (parsed.data.credentials !== undefined) {
    const urlCheck = validateExternalUrl(parsed.data.credentials.url);
    if (!urlCheck.valid) {
      return NextResponse.json({ error: urlCheck.error }, { status: 400 });
    }
    updateData.credentials = encrypt(JSON.stringify(parsed.data.credentials));
    changes.credentials = { from: "[redacted]", to: "[redacted]" };
  }

  const [updated] = await db
    .update(integrationConnections)
    .set(updateData)
    .where(eq(integrationConnections.id, connectionId))
    .returning();

  if (Object.keys(changes).length > 0) {
    appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "config.changed",
      resource: `integration:${connectionId}`,
      detail: { action: "integration_updated", id: connectionId, changes },
      outcome: "success",
    }).catch(console.error);
  }

  return NextResponse.json({
    ...updated,
    credentials: maskConnectionCredentials(updated.type, updated.credentials, decrypt),
  });
}

export async function DELETE(request: NextRequest, { params }: RouteContext) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

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

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "config.changed",
    resource: `integration:${connectionId}`,
    detail: { action: "integration_deleted", type: existing.type, name: existing.name },
    outcome: "success",
  }).catch(console.error);

  return NextResponse.json({ success: true });
}
