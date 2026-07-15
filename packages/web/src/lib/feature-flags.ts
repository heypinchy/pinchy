/**
 * Runtime feature flags.
 *
 * Server-side: read process.env directly (only available on the server).
 * Client-side: read NEXT_PUBLIC_PINCHY_MCP_ENABLED, which next.config.ts
 * forwards from PINCHY_MCP_ENABLED at build time via its `env` block — an
 * operator only needs to set the one server-side variable.
 */

/**
 * Server-side check. Use in API route handlers only.
 *
 * Generic MCP integration support (add MCP server, sync tools, grant tool
 * permissions to agents). When false the entire MCP surface is absent: API
 * routes behave as if type "mcp" doesn't exist (clean 404s, never a 500).
 */
export const isMcpEnabled = (): boolean => process.env.PINCHY_MCP_ENABLED === "1";

/**
 * Client-side check. Safe to call in "use client" components.
 *
 * Gates the MCP UI surface (type picker tiles, connect dialog, permission
 * section): when false, MCP appears nowhere in the UI, mirroring the
 * server-side 404s from isMcpEnabled(). Next.js inlines NEXT_PUBLIC_* env
 * vars at build time, so this must read process.env directly (not go through
 * a runtime config object) for the client bundler to statically replace it.
 */
export const isMcpEnabledClient = (): boolean => process.env.NEXT_PUBLIC_PINCHY_MCP_ENABLED === "1";
