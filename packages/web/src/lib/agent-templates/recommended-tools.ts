/**
 * Helpers for template `recommendedTools` wish-list processing (T9).
 *
 * A template never fails to create an agent because a provider renamed a
 * tool or the admin hasn't connected it yet. Missing tools are silently
 * skipped; the caller receives a skip list it can surface as a non-blocking
 * notice.
 */

import type { RecommendedTool } from "./types";

/** Minimal shape of an active MCP connection needed for tool matching. */
export type McpConnectionInfo = {
  id: string;
  /**
   * Connection preset discriminator. Widened to `string` (rather than
   * `McpPresetId`) because the matching below is plain equality against the
   * wish-list preset — a connection whose preset doesn't match any
   * `RecommendedTool` entry simply never matches, so narrowing the type here
   * buys nothing and would force every caller to filter/narrow first.
   */
  preset: string;
  /** Tool names as advertised by the MCP server at last sync. */
  tools: string[];
};

export type ToolGrant = {
  connectionId: string;
  toolName: string;
};

export type ApplyRecommendedToolsResult = {
  /** Tools successfully matched to an active connection. */
  grants: ToolGrant[];
  /** Tools that had no matching connection or weren't found in the tool list. */
  skipped: RecommendedTool[];
};

/**
 * Match a template's `recommendedTools` wish-list against the available MCP
 * connections. Returns grants (connection × tool pairs ready to insert as
 * `agent_connection_permissions` rows with `model: "mcp"`) and skipped items
 * for caller-side non-blocking display.
 *
 * Rules:
 * - Uses the first active connection that matches `preset`.
 * - If the connection's tool list does not include `tool`, the entry is
 *   skipped — no error is thrown.
 * - If no connection for the preset exists, the entry is skipped.
 */
export function applyRecommendedTools(
  recommendedTools: RecommendedTool[],
  connections: McpConnectionInfo[]
): ApplyRecommendedToolsResult {
  const grants: ToolGrant[] = [];
  const skipped: RecommendedTool[] = [];

  for (const entry of recommendedTools) {
    const connection = connections.find((c) => c.preset === entry.preset);

    if (!connection || !connection.tools.includes(entry.tool)) {
      skipped.push(entry);
      continue;
    }

    grants.push({ connectionId: connection.id, toolName: entry.tool });
  }

  return { grants, skipped };
}
