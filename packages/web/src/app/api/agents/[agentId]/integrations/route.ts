import { NextResponse } from "next/server";
import { eq, and, inArray } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import { agentConnectionPermissions, integrationConnections, agents } from "@/db/schema";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { parseRequestBody } from "@/lib/api-validation";
import { setAgentIntegrationsSchema } from "@/lib/schemas/agent-integrations";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/integrations
 *
 * Returns current integration permissions for this agent, grouped by connection.
 */
export const GET = withAdmin<RouteContext>(async (_req, { params }) => {
  const { agentId } = await params;

  // Join permissions with connections WITHOUT a projection-less
  // `.innerJoin(integrationConnections, …)`. That returns every column of both
  // tables — including the potentially large `integrationConnections.data`
  // jsonb blob (a cached Odoo model catalog) — ONE ROW PER PERMISSION, fanning
  // the blob out across every permission row that references the connection.
  // Same fan-out class as the boot-OOM fixed in build.ts
  // (loadAgentConnectionPermissions); here it is bounded to a single agent but
  // still amplifies (blob size) × (this agent's permission-row count) in one
  // admin request. Load permissions and their referenced connections as two
  // queries and stitch them in memory so each connection blob is fetched once.
  const perms = await db
    .select()
    .from(agentConnectionPermissions)
    .where(eq(agentConnectionPermissions.agentId, agentId));
  const connectionIds = [...new Set(perms.map((p) => p.connectionId))];
  const connections = connectionIds.length
    ? await db
        .select()
        .from(integrationConnections)
        .where(inArray(integrationConnections.id, connectionIds))
    : [];
  const connById = new Map(connections.map((c) => [c.id, c]));
  // Preserve inner-join semantics: a permission is included only if its
  // connection still exists.
  const rows = perms.flatMap((perm) => {
    const conn = connById.get(perm.connectionId);
    return conn ? [{ agent_connection_permissions: perm, integration_connections: conn }] : [];
  });

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

  const parsed = await parseRequestBody(setAgentIntegrationsSchema, request);
  if ("error" in parsed) return parsed.error;
  const { connectionId, permissions } = parsed.data;

  let existingPerms: { model: string; operation: string }[];
  try {
    // Validate the agent exists. The path param is unconstrained; a stale UI
    // can submit a deleted agentId, which would otherwise reach a raw FK
    // violation on insert and surface as a 500 with the DB error text.
    const agentRows = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId));
    if (agentRows.length === 0) {
      return NextResponse.json({ error: "Agent not found" }, { status: 404 });
    }

    // Validate connection exists
    const connRows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    if (connRows.length === 0) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // Atomic replace: read existing → delete → insert within a single transaction
    // to guarantee the INSERT sees the DELETE's effects (avoids unique constraint
    // violations from connection pool timing).
    existingPerms = await db.transaction(async (tx) => {
      const existing = await tx
        .select()
        .from(agentConnectionPermissions)
        .where(
          and(
            eq(agentConnectionPermissions.agentId, agentId),
            eq(agentConnectionPermissions.connectionId, connectionId)
          )
        );

      await tx
        .delete(agentConnectionPermissions)
        .where(
          and(
            eq(agentConnectionPermissions.agentId, agentId),
            eq(agentConnectionPermissions.connectionId, connectionId)
          )
        );

      if (permissions.length > 0) {
        await tx.insert(agentConnectionPermissions).values(
          permissions.map((p: { model: string; operation: string }) => ({
            agentId,
            connectionId: connectionId,
            model: p.model,
            operation: p.operation,
          }))
        );
      }

      return existing;
    });
  } catch (err) {
    // Log the real error server-side, but never echo the raw DB driver message
    // (constraint/table names) back to the client.
    console.error("[integrations PUT] permission update failed:", err);
    return NextResponse.json(
      { error: "Failed to update integration permissions" },
      { status: 500 }
    );
  }

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

  // The permission change has already committed; an audit-write failure must
  // not turn a successful change into a 500. Record the failure for later
  // reconciliation instead (same pattern as the active-error dismiss route).
  const auditEntry: AuditLogEntry = {
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
  };
  try {
    await appendAuditLog(auditEntry);
  } catch (err) {
    recordAuditFailure(err, auditEntry);
  }

  return NextResponse.json({ success: true });
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
