import { NextResponse } from "next/server";
import { eq, and } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { agentConnectionPermissions, integrationConnections } from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/integrations
 *
 * Returns current integration permissions for this agent, grouped by connection.
 */
export const GET = withAdmin<RouteContext>(async (_req, { params }) => {
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
});

/**
 * PUT /api/agents/[agentId]/integrations
 *
 * Replace all permissions for this agent on a given connection.
 */
export const PUT = withAdmin<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { connectionId, permissions } = body;
  if (!connectionId) {
    return NextResponse.json({ error: "connectionId is required" }, { status: 400 });
  }
  if (!Array.isArray(permissions)) {
    return NextResponse.json({ error: "permissions must be an array" }, { status: 400 });
  }

  try {
    // Validate connection exists
    const connRows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId as string));
    if (connRows.length === 0) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Atomic replace: read existing → delete → insert within a single transaction
    // to guarantee the INSERT sees the DELETE's effects (avoids unique constraint
    // violations from connection pool timing).
    const existingPerms = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(agentConnectionPermissions)
        .where(
          and(
            eq(agentConnectionPermissions.agentId, agentId),
            eq(agentConnectionPermissions.connectionId, connectionId as string)
          )
        );

      await tx
        .delete(agentConnectionPermissions)
        .where(
          and(
            eq(agentConnectionPermissions.agentId, agentId),
            eq(agentConnectionPermissions.connectionId, connectionId as string)
          )
        );

      if (permissions.length > 0) {
        await tx.insert(agentConnectionPermissions).values(
          permissions.map((p: { model: string; operation: string }) => ({
            agentId,
            connectionId: connectionId as string,
            model: p.model,
            operation: p.operation,
          }))
        );
      }

      return existing;
    });

    // Config regeneration is NOT done here — the caller (agent settings save flow)
    // triggers it via the agent PATCH, which reads the already-updated permissions
    // from the DB. This avoids double config writes and OpenClaw restarts.

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

    await appendAuditLog({
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
      outcome: "success",
    });

    return NextResponse.json({ success: true });
  } catch (err) {
    console.error("[integrations PUT] Unhandled error:", err);
    const message = err instanceof Error ? err.message : "Internal server error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
});

/**
 * DELETE /api/agents/[agentId]/integrations
 *
 * Remove ALL integration permissions for this agent (used when connection is cleared).
 */
export const DELETE = withAdmin<RouteContext>(async (_req, { params }, session) => {
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

  // Config regeneration is NOT done here — see PUT handler comment.

  // Audit log
  const removed = existingPerms.map((p) => ({ model: p.model, operation: p.operation }));

  await appendAuditLog({
    actorType: "user",
    actorId: session.user.id!,
    eventType: "config.changed",
    resource: `agent:${agentId}`,
    detail: {
      action: "agent_integration_permissions_cleared",
      agentId,
      removed,
    },
    outcome: "success",
  });

  return NextResponse.json({ success: true });
});
