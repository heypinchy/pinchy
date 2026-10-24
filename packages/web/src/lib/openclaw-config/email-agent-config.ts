import type { agentConnectionPermissions, integrationConnections } from "@/db/schema";
import { getEmailToolsForOperations } from "@/lib/tool-registry";
import { EMAIL_CONNECTION_TYPES } from "@/lib/integrations/oauth-providers";

/**
 * Connection types the pinchy-email plugin serves. Pulled out to a set once so
 * membership checks below are O(1).
 */
const EMAIL_PROVIDER_TYPES = new Set<string>(EMAIL_CONNECTION_TYPES);

export type JoinedPermissionRow = {
  agent_connection_permissions: typeof agentConnectionPermissions.$inferSelect;
  integration_connections: typeof integrationConnections.$inferSelect;
};

/**
 * Per-agent aggregation of every email-type connection permission row.
 *
 * LATENT FIRST-WINS BEHAVIOR: the pinchy-email plugin config supports exactly
 * ONE connectionId per agent (`additionalProperties: false` in its manifest)
 * and the UI offers a single Select, so `connectionId`/`connection` stick to
 * the FIRST email-type connection seen while `ops` merge across ALL of them.
 * `connectionIds` exists purely to detect and warn about the multi-connection
 * case.
 */
export interface EmailPermissionsForAgent {
  connectionId: string;
  connection: typeof integrationConnections.$inferSelect;
  connectionIds: Set<string>;
  ops: Map<string, string[]>;
}

/**
 * Groups joined agent-connection-permission rows by agent, keeping only rows
 * whose connection is an email-type integration (see `EMAIL_CONNECTION_TYPES`).
 * Pure: no DB access, no I/O — `allPermissions` is expected to already be
 * loaded (see `loadAgentConnectionPermissions` in build.ts).
 */
export function aggregateEmailPermissionsByAgent(
  allPermissions: JoinedPermissionRow[]
): Map<string, EmailPermissionsForAgent> {
  const emailPermsByAgent = new Map<string, EmailPermissionsForAgent>();

  for (const row of allPermissions) {
    const perm = row.agent_connection_permissions;
    const conn = row.integration_connections;

    if (!EMAIL_PROVIDER_TYPES.has(conn.type)) continue;

    if (!emailPermsByAgent.has(perm.agentId)) {
      emailPermsByAgent.set(perm.agentId, {
        connectionId: perm.connectionId,
        connection: conn,
        connectionIds: new Set(),
        ops: new Map(),
      });
    }
    const agentPerms = emailPermsByAgent.get(perm.agentId)!;
    agentPerms.connectionIds.add(perm.connectionId);

    if (!agentPerms.ops.has(perm.model)) {
      agentPerms.ops.set(perm.model, []);
    }
    agentPerms.ops.get(perm.model)!.push(perm.operation);
  }

  return emailPermsByAgent;
}

/** Per-agent pinchy-email plugin config, emitted into `plugins.entries.pinchy-email.config.agents`. */
export interface EmailAgentConfig {
  connectionId: string;
  permissions: Record<string, string[]>;
  tools: string[];
}

/**
 * Builds the per-agent pinchy-email plugin config from the aggregation above.
 * Unlike Odoo, email config does NOT include decrypted credentials — only
 * connectionId + permissions. The plugin fetches credentials at runtime via
 * the internal API (API-callback pattern).
 *
 * Pure: takes the already-aggregated map, returns a plain object. No DB
 * access, no secret reads.
 */
export function buildEmailAgentConfigs(
  emailPermsByAgent: Map<string, EmailPermissionsForAgent>
): Record<string, EmailAgentConfig> {
  const emailAgentConfigs: Record<string, EmailAgentConfig> = {};

  for (const [agentId, data] of emailPermsByAgent) {
    const permissions: Record<string, string[]> = {};
    for (const [model, ops] of data.ops) {
      permissions[model] = ops;
    }
    // Derive tool names from granted email operations, via tool-registry's
    // getEmailToolsForOperations — the same ops→tools mapping the permission UI
    // uses, where "read" includes email_search (matching the plugin's own gate:
    // email_search checks the "read" permission). A hand-rolled mapping here
    // previously required a separate "search" operation the UI never writes,
    // silently stripping email_search from every UI-configured agent.
    //
    // NOT a gate. This comment used to claim "OpenClaw uses this array to know
    // which plugin-registered tool factories to call — without it, no factory is
    // called and no tools are available", and #1194 disproved it: OpenClaw
    // called every pinchy-email factory and the plugin registered all six tools
    // for any agent with a connection, whatever this array said. OpenClaw does
    // not read a plugin's config shape; only the plugin can. pinchy-email gates
    // on `permissions` (which survives a pre-upgrade config entry that carries
    // no `tools` field at all), so for that plugin this array is emitted and
    // read by nobody — kept because its manifest declares it. pinchy-web DOES
    // read its own `tools` array; the two plugins genuinely differ.
    const emailOps = data.ops.get("email") ?? [];
    const tools = getEmailToolsForOperations(emailOps);
    emailAgentConfigs[agentId] = {
      connectionId: data.connectionId,
      permissions,
      tools,
    };
  }

  return emailAgentConfigs;
}
