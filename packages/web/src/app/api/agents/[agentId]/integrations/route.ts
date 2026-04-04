import { NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { eq, and } from "drizzle-orm";
import { getSession } from "@/lib/auth";
import { db } from "@/db";
import { agentConnectionPermissions, integrationConnections } from "@/db/schema";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import { appendAuditLog } from "@/lib/audit";

/**
 * GET /api/agents/[agentId]/integrations
 *
 * Returns current integration permissions for this agent, grouped by connection.
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { agentId } = await params;

  // Join permissions with connections
  const rows = await db
    .select()
    .from(agentConnectionPermissions)
    .innerJoin(
      integrationConnections,
      eq(agentConnectionPermissions.connectionId, integrationConnections.id)
    )
    .where(eq(agentConnectionPermissions.agentId, agentId));

  // Group by connection
  const grouped = new Map<
    string,
    {
      connectionId: string;
      connectionName: string;
      connectionType: string;
      permissions: Array<{ model: string; modelName: string; operation: string }>;
    }
  >();

  for (const row of rows) {
    const conn = row.integration_connections;
    const perm = row.agent_connection_permissions;

    if (!grouped.has(conn.id)) {
      grouped.set(conn.id, {
        connectionId: conn.id,
        connectionName: conn.name,
        connectionType: conn.type,
        permissions: [],
      });
    }

    // Look up human-readable model name from connection's cached schema
    const models = (conn.data as { models?: Array<{ model: string; name: string }> })?.models;
    const modelInfo = models?.find((m) => m.model === perm.model);
    const modelName = modelInfo?.name ?? perm.model;

    grouped.get(conn.id)!.permissions.push({
      model: perm.model,
      modelName,
      operation: perm.operation,
    });
  }

  return NextResponse.json(Array.from(grouped.values()));
}

/**
 * PUT /api/agents/[agentId]/integrations
 *
 * Replace all permissions for this agent on a given connection.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { agentId } = await params;
  const body = await request.json();

  const { connectionId, permissions } = body;
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
  }
  if (!Array.isArray(permissions)) {
    return NextResponse.json({ error: "permissions must be an array" }, { status: 400 });
  }

  // Validate connection exists
  const connRows = await db
    .select()
    .from(integrationConnections)
    .where(eq(integrationConnections.id, connectionId));
  if (connRows.length === 0) {
    return NextResponse.json({ error: "Connection not found" }, { status: 404 });
  }

  // Get existing permissions for audit diff
  const existingPerms = await db
    .select()
    .from(agentConnectionPermissions)
    .where(
      and(
        eq(agentConnectionPermissions.agentId, agentId),
        eq(agentConnectionPermissions.connectionId, connectionId)
      )
    );

  // Delete all existing permissions for this agent+connection
  await db
    .delete(agentConnectionPermissions)
    .where(
      and(
        eq(agentConnectionPermissions.agentId, agentId),
        eq(agentConnectionPermissions.connectionId, connectionId)
      )
    );

  // Insert new permissions
  if (permissions.length > 0) {
    await db.insert(agentConnectionPermissions).values(
      permissions.map((p: { model: string; operation: string }) => ({
        agentId,
        connectionId,
        model: p.model,
        operation: p.operation,
      }))
    );
  }

  // Regenerate OpenClaw config (permissions changed)
  await regenerateOpenClawConfig();

  // Build audit diff
  const oldSet = new Set(existingPerms.map((p) => `${p.model}:${p.operation}`));
  const newSet = new Set(
    permissions.map((p: { model: string; operation: string }) => `${p.model}:${p.operation}`)
  );

  const added = permissions
    .filter((p: { model: string; operation: string }) => !oldSet.has(`${p.model}:${p.operation}`))
    .map((p: { model: string; operation: string }) => ({
      model: p.model,
      operation: p.operation,
    }));

  const removed = existingPerms
    .filter((p) => !newSet.has(`${p.model}:${p.operation}`))
    .map((p) => ({ model: p.model, operation: p.operation }));

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "config.changed",
    resource: `agent:${agentId}`,
    detail: {
      action: "agent_integration_permissions_updated",
      agentId,
      connectionId,
      changes: { added, removed },
    },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}

/**
 * DELETE /api/agents/[agentId]/integrations
 *
 * Remove ALL integration permissions for this agent (used when connection is cleared).
 */
export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await getSession({ headers: await headers() });
  if (!session?.user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (session.user.role !== "admin") {
    return NextResponse.json({ error: "Admin access required" }, { status: 403 });
  }

  const { agentId } = await params;

  // Get existing permissions for audit log
  const existingPerms = await db
    .select()
    .from(agentConnectionPermissions)
    .where(eq(agentConnectionPermissions.agentId, agentId));

  // Delete all permissions for this agent
  await db
    .delete(agentConnectionPermissions)
    .where(eq(agentConnectionPermissions.agentId, agentId));

  // Regenerate OpenClaw config
  await regenerateOpenClawConfig();

  // Audit log
  const removed = existingPerms.map((p) => ({ model: p.model, operation: p.operation }));

  appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "config.changed",
    resource: `agent:${agentId}`,
    detail: {
      action: "agent_integration_permissions_cleared",
      agentId,
      removed,
    },
  }).catch(() => {});

  return NextResponse.json({ success: true });
}
