/**
 * Runtime feature flags.
 *
 * Server-side: read process.env directly (only available on the server).
 * The client-side NEXT_PUBLIC_PINCHY_MCP_ENABLED counterpart (for gating UI
 * components) is introduced alongside the UI that needs it, not here — see
 * docs/plans/2026-06-30-mcp-port-to-main.md task T8.
 */

/**
 * Server-side check. Use in API route handlers only.
 *
 * Generic MCP integration support (add MCP server, sync tools, grant tool
 * permissions to agents). When false the entire MCP surface is absent: API
 * routes behave as if type "mcp" doesn't exist (clean 404s, never a 500).
 */
export const isMcpEnabled = (): boolean => process.env.PINCHY_MCP_ENABLED === "1";
