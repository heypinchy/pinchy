/**
 * Helpers for template recommendedTools wish-list processing.
 *
 * Design §4.3 — templates never fail because a provider renamed a tool.
 * Missing tools are silently skipped; the caller receives a skip list to
 * surface as a non-blocking toast.
 */

import type { RecommendedTool } from "./types";

/** Minimal shape of an active MCP connection needed for tool matching. */
export type McpConnectionInfo = {
  id: string;
  /**
   * Connection preset discriminator. Widened to `string` because a live
   * connection can be any MCP preset (atlassian, stripe, …), not only the four
   * that `RecommendedTool` references — matching is plain equality against the
   * wish-list preset, so non-matching presets simply never match.
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
 * connections. Returns grants (connection × tool pairs ready to insert into
 * `agentMcpToolPermissions`) and skipped items for caller-side toast display.
 *
 * Rules:
 * - Uses the first active connection that matches `preset`.
 * - If the connection's tool list does not include `tool`, the entry is
 *   skipped — no error is thrown (§4.3).
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
