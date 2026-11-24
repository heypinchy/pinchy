/**
 * MCP constants shared between server-only code and client components.
 *
 * Kept separate from mcp-client.ts on purpose: that module imports the
 * `@modelcontextprotocol/sdk` client (and validateExternalUrl's Node-only DNS
 * checks), so anything a "use client" component imports must NOT pull it in —
 * webpack would bundle the SDK into client JS, and validateExternalUrl's
 * Node-only APIs would break the browser build. mcp-client.ts re-exports
 * RESERVED_HEADERS below so its existing server-side importers are unaffected.
 */

// Headers the client owns — caller-supplied values with these names are
// silently dropped to avoid foot-guns (e.g. a caller forcing a different
// Content-Type that breaks JSON-RPC parsing). Shared by mcp-client.ts's
// discovery path, the MCP credential proxy route, and the create-request
// schema (lib/schemas/mcp-integration.ts) so client-side form validation and
// server-side enforcement can never drift apart.
export const RESERVED_HEADERS = new Set(["authorization", "content-type", "accept"]);
