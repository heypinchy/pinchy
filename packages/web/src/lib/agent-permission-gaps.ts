import type { IncompleteConnectionPermissions } from "@/lib/agents";

/**
 * What both create routes say about a connection that could not grant
 * everything an agent's template requires (heypinchy/pinchy#1208).
 *
 * Shared rather than written twice, because the two routes MUST agree: they
 * differ only in actor (`user` vs `api_key`), and every field below is
 * something an analyst reading the trail — or a provisioning script reading
 * the 201 — will compare across the two. The pair drifted once already, on
 * whether the agent's `name` belongs in the detail.
 *
 * Type-only import from `@/lib/agents`, so this module stays free of the DB
 * driver and can be read from anywhere.
 */

/** The `config.changed` detail body. Routes add their own actor snapshot. */
export function incompletePermissionsDetail(
  agent: { id: string; name: string },
  entry: IncompleteConnectionPermissions
) {
  return {
    action: "agent_integration_permissions_incomplete",
    agentId: agent.id,
    name: agent.name,
    connectionId: entry.connectionId,
    // Snapshot beside the id: the connection may be deleted (or already be
    // gone) by the time anyone reads this, and the row is immutable.
    connectionName: entry.connectionName,
    missingModels: entry.missingModels,
    deniedOperations: entry.deniedOperations,
    warnings: entry.warnings,
  };
}

function describeGap(entry: IncompleteConnectionPermissions): string {
  const label = entry.connectionName ? `"${entry.connectionName}"` : entry.connectionId;

  if (entry.connectionName === null) {
    return `The connection ${label} no longer exists, so none of the Odoo models this template needs could be granted.`;
  }

  const bits: string[] = [];
  if (entry.missingModels.length > 0) {
    bits.push(`models it has never been probed for: ${entry.missingModels.join(", ")}`);
  }
  if (entry.deniedOperations.length > 0) {
    bits.push(
      `operations its Odoo user may not perform: ${entry.deniedOperations
        .map((d) => `${d.model} (${d.operations.join(", ")})`)
        .join(", ")}`
    );
  }

  return (
    `The connection ${label} could not grant everything this template needs — ${bits.join("; ")}. ` +
    `Re-sync its schema in Settings → Integrations, then grant the rest in the agent's Permissions tab.`
  );
}

/**
 * The non-blocking `warning` a 201 carries when the agent came out only partly
 * capable.
 *
 * The provisioning API's reference promises that `warning` is the whole check
 * a caller has to make, and that promise is why this exists: the key route has
 * no UI in front of it, so a script that treats `201` as done would otherwise
 * record a clean create for an agent whose tools fail at first use. Returns
 * `undefined` on a clean create, so the field stays absent.
 */
export function incompletePermissionsWarning(
  entries: IncompleteConnectionPermissions[] | undefined
): string | undefined {
  if (!entries || entries.length === 0) return undefined;
  return entries.map(describeGap).join(" ");
}
