import { NextResponse } from "next/server";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { withAdmin } from "@/lib/api-auth";
import { db } from "@/db";
import {
  agentConnectionPermissions,
  agentMcpToolPermissions,
  integrationConnections,
} from "@/db/schema";
import { appendAuditLog } from "@/lib/audit";
import { parseRequestBody } from "@/lib/api-validation";
import { regenerateOpenClawConfig } from "@/lib/openclaw-config";
import type { McpIntegrationData } from "@/lib/integrations/types";

// ── Discriminated-union types ─────────────────────────────────────────────────

type OdooEntry = { model: string; operation: string };

type IntegrationPermission =
  | { kind: "odoo"; connectionId: string; entries: OdooEntry[] }
  | {
      kind: "mcp";
      connectionId: string;
      connectionName: string;
      availableTools: string[];
      tools: string[];
    };

type DriftEntry = { connectionName: string; removedTool: string };

// ── Zod schemas ───────────────────────────────────────────────────────────────

const odooPermissionSchema = z.object({
  kind: z.literal("odoo"),
  connectionId: z.string().min(1),
  entries: z.array(z.object({ model: z.string().min(1), operation: z.string().min(1) })),
});

const mcpPermissionSchema = z.object({
  kind: z.literal("mcp"),
  connectionId: z.string().min(1),
  tools: z.array(z.string().min(1)),
});

const setAgentIntegrationsSchema = z.array(
  z.discriminatedUnion("kind", [odooPermissionSchema, mcpPermissionSchema])
);

type RouteContext = { params: Promise<{ agentId: string }> };

/**
 * GET /api/agents/[agentId]/integrations
 *
 * Returns current integration permissions for this agent.
 *
 * Response shape:
 * {
 *   permissions: IntegrationPermission[],
 *   drift: Array<{ connectionName: string; removedTool: string }>
 * }
 *
 * Odoo entries: { kind: "odoo", connectionId, entries: [{ model, operation }] }
 * MCP entries:  { kind: "mcp", connectionId, connectionName, availableTools, tools }
 *
 * Drift entries are MCP tool permissions that reference a tool no longer
 * present in the connection's data.tools list (e.g. after a re-sync).
 */
export const GET = withAdmin<RouteContext>(async (_req, { params }) => {
  const { agentId } = await params;

  // ── Odoo permissions ──────────────────────────────────────────────────────
  const odooRows = await db
    .select()
    .from(agentConnectionPermissions)
    .innerJoin(
      integrationConnections,
      eq(agentConnectionPermissions.connectionId, integrationConnections.id)
    )
    .where(eq(agentConnectionPermissions.agentId, agentId));

  const odooGrouped = new Map<
    string,
    { kind: "odoo"; connectionId: string; entries: OdooEntry[] }
  >();

  for (const row of odooRows) {
    const conn = row.integration_connections;
    const perm = row.agent_connection_permissions;

    if (!odooGrouped.has(conn.id)) {
      odooGrouped.set(conn.id, { kind: "odoo", connectionId: conn.id, entries: [] });
    }
    odooGrouped.get(conn.id)!.entries.push({ model: perm.model, operation: perm.operation });
  }

  // ── MCP permissions ───────────────────────────────────────────────────────
  const mcpRows = await db
    .select()
    .from(agentMcpToolPermissions)
    .innerJoin(
      integrationConnections,
      eq(agentMcpToolPermissions.connectionId, integrationConnections.id)
    )
    .where(eq(agentMcpToolPermissions.agentId, agentId));

  const mcpGrouped = new Map<
    string,
    {
      kind: "mcp";
      connectionId: string;
      connectionName: string;
      availableTools: string[];
      tools: string[];
    }
  >();

  const drift: DriftEntry[] = [];

  for (const row of mcpRows) {
    const conn = row.integration_connections;
    const perm = row.agent_mcp_tool_permissions;
    const connData = conn.data as McpIntegrationData | null;
    const availableNames = new Set((connData?.tools ?? []).map((t) => t.name));

    if (!mcpGrouped.has(conn.id)) {
      mcpGrouped.set(conn.id, {
        kind: "mcp",
        connectionId: conn.id,
        connectionName: conn.name,
        availableTools: (connData?.tools ?? []).map((t) => t.name),
        tools: [],
      });
    }

    // Drift detection: tool was granted but no longer available
    if (!availableNames.has(perm.toolName)) {
      drift.push({ connectionName: conn.name, removedTool: perm.toolName });
    } else {
      mcpGrouped.get(conn.id)!.tools.push(perm.toolName);
    }
  }

  // ── Combine and sort by connectionId ──────────────────────────────────────
  const permissions: IntegrationPermission[] = [
    ...odooGrouped.values(),
    ...mcpGrouped.values(),
  ].sort((a, b) => a.connectionId.localeCompare(b.connectionId));

  return NextResponse.json({ permissions, drift });
});

/**
 * PUT /api/agents/[agentId]/integrations
 *
 * Atomically replace ALL integration permissions for this agent.
 * Body: IntegrationPermission[] (discriminated union of odoo/mcp entries)
 *
 * Returns 409 if an MCP tool is no longer available on its connection.
 */
export const PUT = withAdmin<RouteContext>(async (request, { params }, session) => {
  const { agentId } = await params;

  const parsed = await parseRequestBody(setAgentIntegrationsSchema, request);
  if ("error" in parsed) return parsed.error;
  const body = parsed.data;

  try {
    // ── Validate MCP tool availability (before transaction) ─────────────────
    const mcpEntries = body.filter(
      (e): e is Extract<IntegrationPermission, { kind: "mcp" }> => e.kind === "mcp"
    );

    // Load MCP connection data for all MCP entries (for validation + audit snapshot)
    const mcpConnectionMap = new Map<
      string,
      { id: string; name: string; data: McpIntegrationData }
    >();

    for (const entry of mcpEntries) {
      if (mcpConnectionMap.has(entry.connectionId)) continue;

      const connection = await db.query.integrationConnections.findFirst({
        where: eq(integrationConnections.id, entry.connectionId),
      });

      if (!connection) {
        return NextResponse.json({ error: "Connection not found" }, { status: 404 });
      }

      const connData = connection.data as McpIntegrationData;
      mcpConnectionMap.set(entry.connectionId, {
        id: connection.id,
        name: connection.name,
        data: connData,
      });

      const availableTools = new Set(connData.tools.map((t) => t.name));
      for (const tool of entry.tools) {
        if (!availableTools.has(tool)) {
          return NextResponse.json({ error: `Tool no longer available: ${tool}` }, { status: 409 });
        }
      }
    }

    // ── Atomic replace: read old MCP state, delete both tables, re-insert ───
    const oldMcpPerms = await db.transaction(async (tx) => {
      // Read existing MCP permissions before delete (for audit diff)
      const existing = await tx
        .select()
        .from(agentMcpToolPermissions)
        .where(eq(agentMcpToolPermissions.agentId, agentId));

      // Delete all Odoo permissions for this agent
      await tx
        .delete(agentConnectionPermissions)
        .where(eq(agentConnectionPermissions.agentId, agentId));

      // Delete all MCP permissions for this agent
      await tx.delete(agentMcpToolPermissions).where(eq(agentMcpToolPermissions.agentId, agentId));

      // Re-insert Odoo permissions
      const odooEntries = body.filter(
        (e): e is Extract<IntegrationPermission, { kind: "odoo" }> => e.kind === "odoo"
      );
      if (odooEntries.length > 0) {
        const odooRows = odooEntries.flatMap((e) =>
          e.entries.map((perm) => ({
            agentId,
            connectionId: e.connectionId,
            model: perm.model,
            operation: perm.operation,
          }))
        );
        if (odooRows.length > 0) {
          await tx.insert(agentConnectionPermissions).values(odooRows);
        }
      }

      // Re-insert MCP permissions
      if (mcpEntries.length > 0) {
        const mcpRows = mcpEntries.flatMap((e) =>
          e.tools.map((tool) => ({
            agentId,
            connectionId: e.connectionId,
            toolName: tool,
          }))
        );
        if (mcpRows.length > 0) {
          await tx.insert(agentMcpToolPermissions).values(mcpRows);
        }
      }

      return existing;
    });

    // ── Compute MCP diff for audit ──────────────────────────────────────────
    // Group old MCP perms by connectionId
    const oldMcpByConn = new Map<string, Set<string>>();
    for (const perm of oldMcpPerms) {
      const set = oldMcpByConn.get(perm.connectionId) ?? new Set<string>();
      set.add(perm.toolName);
      oldMcpByConn.set(perm.connectionId, set);
    }

    // Group new MCP perms by connectionId
    const newMcpByConn = new Map<string, Set<string>>();
    for (const entry of mcpEntries) {
      newMcpByConn.set(entry.connectionId, new Set(entry.tools));
    }

    // Collect all affected connectionIds
    const allConnIds = new Set([...oldMcpByConn.keys(), ...newMcpByConn.keys()]);

    const mcpToolsAdded: Array<{ connection: { id: string; name: string }; tool: string }> = [];
    const mcpToolsRemoved: Array<{ connection: { id: string; name: string }; tool: string }> = [];

    for (const connId of allConnIds) {
      const conn = mcpConnectionMap.get(connId);
      const connSnapshot = conn ? { id: conn.id, name: conn.name } : { id: connId, name: connId };

      const oldTools = oldMcpByConn.get(connId) ?? new Set<string>();
      const newTools = newMcpByConn.get(connId) ?? new Set<string>();

      for (const tool of newTools) {
        if (!oldTools.has(tool)) {
          mcpToolsAdded.push({ connection: connSnapshot, tool });
        }
      }
      for (const tool of oldTools) {
        if (!newTools.has(tool)) {
          mcpToolsRemoved.push({ connection: connSnapshot, tool });
        }
      }
    }

    // ── Regenerate OpenClaw config ─────────────────────────────────────────
    await regenerateOpenClawConfig();

    // ── Audit log ──────────────────────────────────────────────────────────
    // `UpdateDetail` requires `changes: Record<string, { from, to }>`.
    // The structured MCP diff (added/removed) doesn't fit that shape, so we
    // use the `[key: string]: unknown` index on `UpdateDetail` to carry it as
    // a top-level sibling of `changes`.
    await appendAuditLog({
      actorType: "user",
      actorId: session.user.id!,
      eventType: "agent.updated",
      resource: `agent:${agentId}`,
      detail: {
        agentId,
        changes: {},
        mcpTools: {
          added: mcpToolsAdded,
          removed: mcpToolsRemoved,
        },
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

  // Get existing Odoo permissions for audit log
  const existingOdooPerms = await db
    .select()
    .from(agentConnectionPermissions)
    .where(eq(agentConnectionPermissions.agentId, agentId));

  // Delete all Odoo permissions for this agent
  await db
    .delete(agentConnectionPermissions)
    .where(eq(agentConnectionPermissions.agentId, agentId));

  // Delete all MCP permissions for this agent
  await db.delete(agentMcpToolPermissions).where(eq(agentMcpToolPermissions.agentId, agentId));

  // Audit log
  const removed = existingOdooPerms.map((p) => ({ model: p.model, operation: p.operation }));

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
