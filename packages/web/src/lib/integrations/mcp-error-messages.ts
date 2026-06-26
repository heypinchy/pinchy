/**
 * Human-friendly error messages for MCP connection failures.
 *
 * Client-safe module: no imports from mcp-client.ts (which pulls in the MCP
 * SDK and is server-only). The server derives an `McpErrorCode` from its
 * typed errors (mcpErrorCodeFromError in mcp-client.ts) and ships it to the
 * browser; this module turns the code into copy that follows PERSONALITY.md
 * § Error Messages: honest, helpful, no blame — and no protocol jargon.
 * Users clicked "GitHub" in the picker; that we speak MCP underneath is an
 * implementation detail they should never have to decode.
 */

export type McpErrorCode = "unauthorized" | "server_error" | "schema" | "network";

export interface McpErrorDisplay {
  /** The human-friendly message shown inline in the dialog. */
  message: string;
  /**
   * Raw technical error, surfaced only for custom MCP servers — their admins
   * run the server themselves, so the raw response is genuinely useful.
   */
  detail?: string;
}

export function mcpErrorMessage(opts: {
  code: McpErrorCode | undefined;
  /** Brand name from the preset registry, e.g. "GitHub". */
  providerName: string;
  /** True for the generic/custom preset — wording shifts to "the server". */
  isCustom: boolean;
  /** Raw error string from the API, e.g. "MCP server returned 401 Unauthorized". */
  rawMessage?: string;
}): McpErrorDisplay {
  const { code, providerName, isCustom, rawMessage } = opts;

  const message = isCustom ? customMessage(code) : namedMessage(code, providerName);
  return isCustom && rawMessage ? { message, detail: rawMessage } : { message };
}

function namedMessage(code: McpErrorCode | undefined, provider: string): string {
  switch (code) {
    case "unauthorized":
      return `${provider} rejected this token. Check that it hasn't expired and has the permissions listed above, then paste a fresh one.`;
    case "server_error":
      return `${provider} couldn't process the request right now. Try again in a moment.`;
    case "network":
      // Named presets have a fixed URL — pointing at the URL would mislead.
      return `Couldn't reach ${provider}. Check your network connection and try again.`;
    case "schema":
      return `${provider} responded in an unexpected format. Try again — if this keeps happening, the integration may need an update.`;
    default:
      return `Connecting to ${provider} failed. Check your input and try again.`;
  }
}

function customMessage(code: McpErrorCode | undefined): string {
  switch (code) {
    case "unauthorized":
      return "The server rejected this token. Check that it's valid and hasn't expired.";
    case "server_error":
      return "The server couldn't process the request. Check its logs and try again.";
    case "network":
      // The URL is user-entered in the custom flow — it's the prime suspect.
      return "Couldn't reach the server. Check the URL and your network connection.";
    case "schema":
      return "The server's response doesn't look like a valid MCP tool list. Check that the URL points at an MCP-compatible endpoint.";
    default:
      return "Connecting to the server failed. Check your input and try again.";
  }
}
