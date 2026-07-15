/**
 * Runtime feature flags.
 *
 * Server-side only, by design. There is exactly ONE MCP flag —
 * PINCHY_MCP_ENABLED — read live from process.env on every call.
 *
 * There is deliberately no client-side counterpart. A NEXT_PUBLIC_* variable
 * (however it is populated, including via next.config.ts's `env` block) is
 * inlined into the client bundle at BUILD time, and Pinchy ships as a
 * prebuilt image: the value would be frozen to whatever CI had when the image
 * was built. An operator setting PINCHY_MCP_ENABLED=1 in their runtime .env
 * would arm the API while the UI stayed dark forever — a silent half-state.
 *
 * Client components get the flag as a plain `mcpEnabled` prop from the server
 * component that renders them (app/(app)/settings/integrations/new/page.tsx
 * and app/(app)/settings/page.tsx). That is the same idiom
 * app/(app)/usage/page.tsx uses to pass the enterprise license state down.
 */

/**
 * Generic MCP integration support (add MCP server, sync tools, grant tool
 * permissions to agents). When false the entire MCP surface is absent: API
 * routes behave as if type "mcp" doesn't exist (clean 404s, never a 500), and
 * the UI renders no MCP tiles and no MCP connect step.
 *
 * Safe to call from API route handlers and server components.
 */
export const isMcpEnabled = (): boolean => process.env.PINCHY_MCP_ENABLED === "1";
