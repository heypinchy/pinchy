import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { integrationConnections, agents, agentConnectionPermissions } from "@/db/schema";
import { encrypt, decrypt } from "@/lib/encryption";
import { appendAuditLog } from "@/lib/audit";
import { odooCredentialsSchema } from "@/lib/integrations/odoo-schema";
import { validateExternalUrl } from "@/lib/integrations/url-validation";
import { maskConnectionCredentials } from "@/lib/integrations/mask-credentials";
import { finalizeIntegrationDeletion } from "@/lib/integrations/finalize-deletion";
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

// audit-exempt: audit log is written by finalizeIntegrationDeletion after successful deletion
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

  // Preflight: refuse if any agent permission still references this connection
  const affectedAgents = await db
    .selectDistinct({ id: agents.id, name: agents.name })
    .from(agentConnectionPermissions)
    .innerJoin(agents, eq(agentConnectionPermissions.agentId, agents.id))
    .where(eq(agentConnectionPermissions.connectionId, connectionId));

  if (affectedAgents.length > 0) {
    return NextResponse.json(
      { error: "Integration has active permissions", agents: affectedAgents },
      { status: 409 }
    );
  }

  try {
    await db.delete(integrationConnections).where(eq(integrationConnections.id, connectionId));
  } catch (err: unknown) {
    const pgErr = err as { code?: string };
    if (pgErr?.code === "23503") {
      // TOCTOU: a permission was inserted between the preflight check and the delete.
      // Re-fetch to return a meaningful 409 instead of a 500.
      const agentsNow = await db
        .selectDistinct({ id: agents.id, name: agents.name })
        .from(agentConnectionPermissions)
        .innerJoin(agents, eq(agentConnectionPermissions.agentId, agents.id))
        .where(eq(agentConnectionPermissions.connectionId, connectionId));
      return NextResponse.json(
        { error: "Integration has active permissions", agents: agentsNow },
        { status: 409 }
      );
    }
    throw err;
  }

  await finalizeIntegrationDeletion({
    actorId: session.user.id!,
    connection: existing,
    detachedAgents: [],
  });

  return NextResponse.json({ success: true });
}
