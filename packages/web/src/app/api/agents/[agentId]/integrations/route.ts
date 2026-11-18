import { NextResponse } from "next/server";
import { eq, and, ne, inArray } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { getAgentWithAccess } from "@/lib/agent-access";
import { db } from "@/db";
import { agentConnectionPermissions, integrationConnections } from "@/db/schema";
import { appendAuditLog, type AuditLogEntry } from "@/lib/audit";
import { recordAuditFailure } from "@/lib/audit-deferred";
import { parseRequestBody } from "@/lib/api-validation";
import { setAgentIntegrationsSchema } from "@/lib/schemas/agent-integrations";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import type { McpIntegrationData } from "@/lib/integrations/types";

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/integrations
 *
 * Returns current integration permissions for this agent, grouped by connection.
 *
 * Admin-only AND gated on the admin's own view of the agent: another user's
 * personal agent answers 404, the same answer an id nobody ever issued gets.
 * Being an admin is not a visibility rule — see getAgentWithAccess's docblock
 * for the verdict, and `PATCH`/`DELETE /api/agents/:id` for the two routes that
 * already answered this way.
 *
 * Until the gate landed this route checked nothing at all, so it answered `200
 * []` for every id — indistinguishable from a real agent that simply has no
 * integrations.
 */
export const GET = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

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
 *
 * The sharpest of this file's three handlers, and the reason the read gate
 * belongs on all of them: this is a permission WRITE, not index management.
 * Granting another user's private Smithers live access to an Odoo or email
 * connection would be invisible to its owner and absent from every list the
 * granting admin can see.
 */
export const PUT = withAdmin<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  // Also the agent's existence check, which this route used to run against
  // `agents` — the gate reads `active_agents`, so a soft-deleted agent now
  // answers 404 instead of accepting permission rows. The FK violation that
  // check was written for (a stale UI submitting a deleted id) stays covered.
  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  const parsed = await parseRequestBody(setAgentIntegrationsSchema, request);
  if ("error" in parsed) return parsed.error;
  const { connectionId, permissions } = parsed.data;

  let existingPerms: { model: string; operation: string }[];
  try {
    // Validate connection exists
    const connRows = await db
      .select()
      .from(integrationConnections)
      .where(eq(integrationConnections.id, connectionId));
    if (connRows.length === 0) {
      return NextResponse.json({ error: "Connection not found" }, { status: 404 });
    }

    // MCP grants (model:"mcp") name a tool on THIS specific connection —
    // unlike Odoo/email operations, which are a fixed, model-independent
    // vocabulary, MCP tool names come from a third-party server and only
    // make sense against the connection that discovered them. `connRows` is
    // already loaded above, so this costs no extra query.
    //
    // This is write-time UX hardening (an honest 400 instead of a silently
    // inert grant) — it is NOT a substitute for read-time gating. A later
    // re-sync (POST .../sync) can remove a tool from `data.tools` *after*
    // the grant below is written, and this route has no way to catch that
    // drift. T6 (build.ts) MUST intersect grants against the connection's
    // *current* data.tools before emitting `tools.allow`, and T7's skill
    // body must be derived from that same intersection — never from the raw
    // grant rows — or a revoked tool stays silently exposed.
    const mcpPermissions = permissions.filter((p) => p.model === "mcp");
    if (mcpPermissions.length > 0) {
      const connection = connRows[0];
      if (connection.type !== "mcp") {
        return NextResponse.json(
          { error: "Connection is not an MCP integration" },
          { status: 400 }
        );
      }
      const syncedTools = new Set(
        ((connection.data as McpIntegrationData | null)?.tools ?? []).map((t) => t.name)
      );
      const unknownTools = mcpPermissions
        .map((p) => p.operation)
        .filter((toolName) => !syncedTools.has(toolName));
      if (unknownTools.length > 0) {
        return NextResponse.json(
          {
            error: `Unknown MCP tool(s), not present in the connection's synced tool list: ${unknownTools.join(", ")}`,
          },
          { status: 400 }
        );
      }
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

  // Config regeneration is NOT done here for Odoo/email — the caller (agent
  // settings save flow) triggers it via the agent PATCH, which reads the
  // already-updated permissions from the DB. This avoids double config
  // writes and OpenClaw restarts for those types, whose gating is a runtime
  // plugin checkPermission and never depends on config content.
  //
  // MCP is different (see docs/plans/2026-06-30-mcp-port-to-main.md task
  // T6): its ENTIRE gating lives in openclaw.json (mcp.servers +
  // tools.allow, build.ts). Without regenerating here, a freshly granted
  // tool stays unusable — and worse, a REVOKED tool stays silently allowed
  // — until some unrelated regenerate happens to notice. So this route
  // regenerates immediately whenever an "mcp" row is touched on either side
  // of the replace (added, removed, or both) — checking only the new
  // `permissions` array would miss a pure revocation (permissions: []).

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

  const touchesMcp = added.some((p) => p.model === "mcp") || removed.some((p) => p.model === "mcp");
  if (touchesMcp) {
    await regenerateOpenClawConfig();
  }

  return NextResponse.json({ success: true });
});

/**
 * DELETE /api/agents/[agentId]/integrations
 *
 * Remove this agent's Odoo/email integration permissions (used when the settings
 * page reports none). MCP grants are left alone, see below.
 *
 * Gated like its siblings. It, too, checked nothing before: an unknown id was
 * answered `200 {success:true}` and given a `config.changed` audit row claiming
 * permissions had been cleared.
 */
export const DELETE = withAdmin<RouteContext>(async (_req, { params }, session) => {
  const { agentId } = await params;

  const agentOrError = await getAgentWithAccess(agentId, session.user.id!, session.user.role);
  if (agentOrError instanceof NextResponse) return agentOrError;

  // MCP grants are not cleared here. They are managed per connection (PUT
  // with an empty list revokes them), and the settings page calls this route
  // when no Odoo/email section reports a grant — an MCP section that is not
  // rendered (flag off, connection in auth_failed) reports nothing either, so
  // a blanket delete would wipe grants the admin never saw.
  const notMcp = and(
    eq(agentConnectionPermissions.agentId, agentId),
    ne(agentConnectionPermissions.model, "mcp")
  );

  const existingPerms = await db.select().from(agentConnectionPermissions).where(notMcp);
  await db.delete(agentConnectionPermissions).where(notMcp);

  // Config regeneration is NOT done here — see PUT handler comment. The rows
  // cleared here are Odoo/email grants, gated at tool-call time.
  const removed = existingPerms.map((p) => ({ model: p.model, operation: p.operation }));

  // The rows are gone; an audit-write failure must not turn that into a 500.
  const auditEntry: AuditLogEntry = {
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
  };
  try {
    await appendAuditLog(auditEntry);
  } catch (err) {
    recordAuditFailure(err, auditEntry);
  }

  return NextResponse.json({ success: true });
});
