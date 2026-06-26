/**
 * Transforms Pinchy's active MCP connections + per-agent tool grants into the
 * pieces OpenClaw's NATIVE remote-MCP support consumes — pointed at Pinchy's
 * credential-injecting proxy:
 *
 *   - `servers`: a `mcp.servers.<serverKey>` map whose `url` is the PINCHY
 *     proxy (`<proxyBaseUrl>/api/internal/mcp-proxy/<connectionId>`), NOT the
 *     third-party server. The only header is the gateway bootstrap token
 *     (already in openclaw.json as a Pattern-C credential) — never a third-party
 *     secret. OpenClaw connects to the proxy; the proxy decrypts + injects the
 *     real token at request time and forwards to the upstream. So no third-party
 *     credential ever lands in openclaw.json, and no OpenClaw restart is needed
 *     to add or rotate a connection.
 *   - `toolAllowByAgent`: native MCP tools are named `<serverKey>__<toolName>`
 *     (OpenClaw's buildSafeToolName); per-agent gating rides the standard tool
 *     policy `agents.list[].tools.allow`.
 *
 * The server KEY is a sanitized, stable, unique, ≤30-char, letter-initial id —
 * NOT the raw connectionId. OpenClaw rewrites mcp.servers keys into model-facing
 * tool prefixes (agent-bundle-mcp-names: `/[^A-Za-z0-9_-]/ → "-"`, an "mcp-"
 * prefix for non-letter-initial names, truncation to 30 chars, plus a stateful
 * collision suffix). A raw 36-char UUID — usually digit-initial — would be both
 * prefixed AND truncated, so the materialized tool name (`<safeServerName>__…`)
 * would no longer equal what we emit into `tools.allow`, silently denying every
 * MCP tool. By keying with an already-safe id we make OpenClaw's sanitizer an
 * identity, so `tools.allow` matches the materialized name exactly. The proxy
 * URL still carries the real connectionId, so the key needn't be reversible.
 *
 * Pure + deterministic so it's unit-testable away from build.ts / the DB.
 */

// Mirrors OpenClaw's TOOL_NAME_SAFE_RE / length limits (agent-bundle-mcp-names).
const TOOL_NAME_SAFE_RE = /[^A-Za-z0-9_-]/g;
const TOOL_NAME_MAX_PREFIX = 30; // server-name (prefix) budget
const TOOL_NAME_MAX_TOTAL = 64; // full `<server>__<tool>` budget

export interface NativeMcpConnectionInput {
  id: string;
  /** Transport OpenClaw must speak to reach the (proxied) server. */
  transport: "http" | "sse" | "streamable-http";
  /** agentId → granted (drift-filtered) tool names for this connection. */
  agentTools: Record<string, string[]>;
}

export interface NativeMcpOptions {
  /** Base URL OpenClaw uses to reach Pinchy (e.g. http://pinchy:7777). */
  proxyBaseUrl: string;
  /** Gateway bootstrap token OpenClaw presents to the Pinchy proxy. */
  gatewayToken: string;
}

export interface NativeMcpConfig {
  servers: Record<string, { url: string; transport: string; headers: Record<string, string> }>;
  toolAllowByAgent: Record<string, string[]>;
}

/**
 * Stable, sanitized, ≤30-char, letter-initial `mcp.servers` key for a
 * connection. `"m"` prefix guarantees a letter start (so OpenClaw adds no
 * "mcp-" prefix); stripping non-alphanumerics keeps it in the safe set; the
 * 30-char slice avoids OpenClaw's truncation. For UUID connectionIds this
 * preserves ~116 bits — collision-safe — and `buildNativeMcp` additionally
 * asserts global uniqueness so a (vanishingly unlikely) clash fails loudly
 * instead of silently mis-gating tools.
 */
export function mcpServerKey(connectionId: string): string {
  return `m${connectionId.replace(/[^A-Za-z0-9]/g, "")}`.slice(0, TOOL_NAME_MAX_PREFIX);
}

/** Replicates OpenClaw's sanitizeToolName (fragment-level, no truncation). */
function sanitizeToolFragment(raw: string): string {
  const normalized = raw.trim().replace(TOOL_NAME_SAFE_RE, "-") || "tool";
  return /^[A-Za-z]/.test(normalized) ? normalized : `tool-${normalized}`;
}

/**
 * OpenClaw's materialized tool id: `<serverKey>__<sanitizedTool>`, with the
 * tool fragment truncated to the remaining budget (buildSafeToolName).
 */
export function nativeMcpToolName(connectionId: string, toolName: string): string {
  const key = mcpServerKey(connectionId);
  const maxToolChars = Math.max(1, TOOL_NAME_MAX_TOTAL - key.length - 2);
  return `${key}__${sanitizeToolFragment(toolName).slice(0, maxToolChars)}`;
}

/** Pinchy proxy URL for a connection — OpenClaw points its mcp.server here. */
export function mcpProxyUrl(proxyBaseUrl: string, connectionId: string): string {
  return `${proxyBaseUrl.replace(/\/$/, "")}/api/internal/mcp-proxy/${connectionId}`;
}

function normalizeTransport(transport: string): string {
  // OpenClaw canonicalizes CLI `type: "http"` to `streamable-http`.
  return transport === "http" ? "streamable-http" : transport;
}

export function buildNativeMcp(
  connections: NativeMcpConnectionInput[],
  opts: NativeMcpOptions
): NativeMcpConfig {
  const servers: NativeMcpConfig["servers"] = {};
  const toolAllowByAgent: Record<string, string[]> = {};

  for (const conn of connections) {
    const key = mcpServerKey(conn.id);
    if (Object.prototype.hasOwnProperty.call(servers, key)) {
      // Two connectionIds collapsed to the same sanitized key — astronomically
      // unlikely for UUIDs, but fail loudly rather than silently mis-gate tools.
      throw new Error(`Duplicate MCP server key "${key}" — connectionId collision`);
    }

    servers[key] = {
      url: mcpProxyUrl(opts.proxyBaseUrl, conn.id),
      transport: normalizeTransport(conn.transport),
      headers: {
        Authorization: `Bearer ${opts.gatewayToken}`,
      },
    };

    for (const [agentId, tools] of Object.entries(conn.agentTools)) {
      const names = tools.map((t) => nativeMcpToolName(conn.id, t));
      toolAllowByAgent[agentId] = [...(toolAllowByAgent[agentId] ?? []), ...names];
    }
  }

  return { servers, toolAllowByAgent };
}
