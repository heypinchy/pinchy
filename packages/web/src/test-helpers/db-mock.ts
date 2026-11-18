import { vi } from "vitest";
import { agentConnectionPermissions, integrationConnections, channelLinks } from "@/db/schema";

/**
 * Wires a `db.select()` mock for tests exercising the two-query permissions
 * load (`loadAgentConnectionPermissions` in `@/lib/openclaw-config/build`,
 * added to fix a boot-OOM fan-out bug: the old single `.innerJoin()` query
 * fanned the (potentially large) `integrationConnections.data` blob out
 * across every permission row referencing it).
 *
 * Routes `.from()` by table identity:
 *   - `.from(agents)` (or any other table) → `agentsData`, bare-awaited —
 *     mirrors `db.select().from(agents)`.
 *   - `.from(agentConnectionPermissions)` → the permission rows extracted
 *     from `permissionsData`, bare-awaited (no `.where()`/`.innerJoin()`).
 *   - `.from(integrationConnections).where(...)` → the de-duplicated set of
 *     connections referenced by `permissionsData` on the FIRST call, and
 *     `webSearchConnections` on subsequent calls — matching build.ts's query
 *     order (permissions' active-connection query runs before the later,
 *     separate web-search connections query).
 *   - `.from(channelLinks)` → `[]` (callers needing channel-links data
 *     should wire that table directly).
 *
 * `permissionsData` uses the old joined-row shape (`{
 * agent_connection_permissions, integration_connections }`) that test
 * fixtures already use throughout this codebase — this helper reconstructs
 * the two-query split from it so existing fixtures don't need reshaping.
 */
export function mockJoinedPermissionsDb(
  agentsData: unknown[],
  permissionsData: Array<{
    agent_connection_permissions: unknown;
    integration_connections: Record<string, unknown>;
  }>,
  webSearchConnections: unknown[] = []
) {
  const permRows = permissionsData.map((r) => r.agent_connection_permissions);
  const seenConnIds = new Set<unknown>();
  const activeConnections: unknown[] = [];
  for (const row of permissionsData) {
    const conn = row.integration_connections;
    if (!seenConnIds.has(conn.id)) {
      seenConnIds.add(conn.id);
      activeConnections.push(conn);
    }
  }

  let integrationConnectionsCallCount = 0;
  return {
    from: vi.fn().mockImplementation((table: unknown) => {
      if (table === agentConnectionPermissions) {
        return Promise.resolve(permRows);
      }
      if (table === integrationConnections) {
        integrationConnectionsCallCount++;
        const result =
          integrationConnectionsCallCount === 1 ? activeConnections : webSearchConnections;
        return { where: vi.fn().mockResolvedValue(result) };
      }
      if (table === channelLinks) {
        return Promise.resolve([]);
      }
      return Object.assign(Promise.resolve(agentsData), {
        where: vi.fn().mockResolvedValue(agentsData),
      });
    }),
  };
}
