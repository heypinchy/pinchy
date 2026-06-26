/**
 * Runtime feature flags.
 *
 * Server-side: read process.env directly (only available on the server).
 * Client-side: read NEXT_PUBLIC_* env vars (baked in at build time by Next.js).
 *
 * To enable the MCP feature, set both:
 *   PINCHY_MCP_ENABLED=1            (server-side API routes)
 *   NEXT_PUBLIC_PINCHY_MCP_ENABLED=1  (client-side UI components)
 *
 * In practice, set PINCHY_MCP_ENABLED=1 in the environment and rely on
 * next.config.ts forwarding it via the `env` block as NEXT_PUBLIC_PINCHY_MCP_ENABLED.
 */

/**
 * Server-side check. Use in API route handlers only.
 *
 * Generic MCP integration support (add MCP server, sync tools, grant tool
 * permissions to agents).  When false the entire MCP surface is absent:
 * API routes return 404.
 */
export const isMcpEnabled = () => process.env.PINCHY_MCP_ENABLED === "1";

/**
 * Client-side check. Safe to call in "use client" components.
 *
 * Reads NEXT_PUBLIC_PINCHY_MCP_ENABLED which Next.js replaces at build time.
 * Mirror the server-side flag by setting NEXT_PUBLIC_PINCHY_MCP_ENABLED=1.
 */
export const isMcpEnabledClient = () => process.env.NEXT_PUBLIC_PINCHY_MCP_ENABLED === "1";
