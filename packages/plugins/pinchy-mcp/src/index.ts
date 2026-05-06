/**
 * pinchy-mcp plugin
 *
 * Connects agents to external MCP servers (HTTP or SSE transport).
 * For each configured connection, all tool names that appear in ANY
 * agent's allowlist are exposed as OpenClaw tools. At execution time,
 * per-agent allowlist enforcement is applied and credentials are
 * fetched lazily from Pinchy's internal credentials API (Pattern B).
 *
 * Credential TTL: 5 minutes. On 401 from the MCP server the cache is
 * invalidated and the call is retried once with fresh credentials.
 *
 * See AGENTS.md § Secret Handling — Pattern B.
 */

import { CredentialCache } from "./credential-cache.js";

// ─── Types ────────────────────────────────────────────────────────────────────

interface PluginToolContext {
  agentId?: string;
}

interface ContentBlock {
  type: string;
  text: string;
}

interface ToolResult {
  content: ContentBlock[];
  isError?: boolean;
}

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<ToolResult>;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  registerTool: (
    factory: (ctx: PluginToolContext) => AgentTool | null,
    opts?: { name?: string }
  ) => void;
}

interface ConnectionConfig {
  connectionId: string;
  preset: string;
  transport: "http" | "sse";
  url: string;
  toolPrefix: string;
  agentTools: Record<string, string[]>; // agentId → allowed tool names
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  connections: ConnectionConfig[];
}

// ─── Credential fetching ──────────────────────────────────────────────────────

async function fetchCredentials(
  apiBaseUrl: string,
  gatewayToken: string,
  connectionId: string
): Promise<string> {
  const url = `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${gatewayToken}` },
  });
  if (!res.ok) {
    throw new Error(
      `pinchy-mcp: credential fetch failed for connection ${connectionId}: HTTP ${res.status}`
    );
  }
  const data = (await res.json()) as { credentials: { token: string } };
  if (!data.credentials?.token || typeof data.credentials.token !== "string") {
    throw new Error(
      `pinchy-mcp: credential response missing credentials.token for connection ${connectionId}`
    );
  }
  return data.credentials.token;
}

// ─── MCP tool call (JSON-RPC over HTTP) ───────────────────────────────────────

async function callMcpTool(
  url: string,
  toolName: string,
  args: Record<string, unknown>,
  token: string
): Promise<ToolResult> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args },
    }),
  });

  if (!res.ok) {
    const status = res.status;
    // Propagate as a special marker so the caller can detect 401
    const err = new Error(`HTTP ${status}`);
    (err as Error & { status: number }).status = status;
    throw err;
  }

  const body = (await res.json()) as {
    result?: { content?: ContentBlock[]; isError?: boolean };
    error?: { message?: string };
  };

  if (body.error) {
    return {
      isError: true,
      content: [{ type: "text", text: `MCP error: ${body.error.message ?? "Unknown error"}` }],
    };
  }

  return {
    content: body.result?.content ?? [{ type: "text", text: "" }],
    isError: body.result?.isError,
  };
}

// ─── Plugin definition ────────────────────────────────────────────────────────

const plugin = {
  id: "pinchy-mcp",
  name: "Pinchy MCP",
  description:
    "MCP (Model Context Protocol) server integration. Connects agents to external MCP servers, exposing their tools as native agent capabilities.",

  configSchema: {
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "apiBaseUrl" in value &&
        "gatewayToken" in value &&
        "connections" in value &&
        Array.isArray((value as Record<string, unknown>).connections)
      ) {
        return { ok: true as const, value };
      }
      return {
        ok: false as const,
        errors: ["Missing required keys in pinchy-mcp config"],
      };
    },
  },

  register(api: PluginApi) {
    const config = api.pluginConfig;
    if (!config) return;

    const { apiBaseUrl, gatewayToken, connections } = config;

    // One credential cache per plugin instance (shared across connections)
    const credCache = new CredentialCache();

    for (const connection of connections) {
      const { connectionId, url, toolPrefix, agentTools } = connection;

      // Collect the union of all tool names across all agents for this connection
      const allToolNames = new Set<string>();
      for (const toolList of Object.values(agentTools)) {
        for (const toolName of toolList) {
          allToolNames.add(toolName);
        }
      }

      // Register one tool per unique tool name.
      // setImmediate() is used inside execute() to yield in per-agent
      // processing loops (per AGENTS.md: worker_threads + tsx unavailable
      // in the OC container).
      for (const toolName of allToolNames) {
        const toolId = `${toolPrefix}${toolName}`;

        api.registerTool(
          (ctx: PluginToolContext) => {
            const agentId = ctx.agentId;
            if (!agentId) return null;

            // Only expose this tool to agents that have at least one tool
            // allowlisted for this connection.
            if (!agentTools[agentId]) return null;

            return {
              name: toolId,
              label: toolId.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
              description: `Call the ${toolName} tool on the ${connection.preset} MCP server (connection: ${connectionId}).`,
              parameters: {
                type: "object",
                additionalProperties: true,
              },

              async execute(
                _toolCallId: string,
                params: Record<string, unknown>
              ): Promise<ToolResult> {
                // Per-agent allowlist check: the factory exposes this tool to any
                // agent that has ANY tools on this connection, but execute enforces
                // the precise per-tool permission.
                const allowed = agentTools[agentId] ?? [];
                if (!allowed.includes(toolName)) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: `Tool "${toolName}" is not allowed for this agent. Check the agent's MCP tool permissions.`,
                      },
                    ],
                  };
                }

                // Yield before the credential fetch to avoid blocking the event
                // loop when many tools are invoked in the same tick.
                await new Promise<void>((resolve) => setImmediate(resolve));

                // Lazy credential fetch (cached, 5-minute TTL)
                let token: string;
                try {
                  token = await credCache.get(connectionId, () =>
                    fetchCredentials(apiBaseUrl, gatewayToken, connectionId)
                  );
                } catch (err) {
                  const message = err instanceof Error ? err.message : "Unknown error";
                  return {
                    isError: true,
                    content: [{ type: "text", text: `Credential fetch failed: ${message}` }],
                  };
                }

                // Call MCP server, retry once on 401 (stale credentials)
                try {
                  return await callMcpTool(url, toolName, params, token);
                } catch (err) {
                  const status = (err as Error & { status?: number }).status;
                  if (status === 401) {
                    // Invalidate cache and retry once with fresh credentials
                    credCache.invalidate(connectionId);
                    try {
                      token = await credCache.get(connectionId, () =>
                        fetchCredentials(apiBaseUrl, gatewayToken, connectionId)
                      );
                      return await callMcpTool(url, toolName, params, token);
                    } catch (retryErr) {
                      const message =
                        retryErr instanceof Error ? retryErr.message : "Unknown error";
                      return {
                        isError: true,
                        content: [{ type: "text", text: `MCP call failed after retry: ${message}` }],
                      };
                    }
                  }
                  const message = err instanceof Error ? err.message : "Unknown error";
                  return {
                    isError: true,
                    content: [{ type: "text", text: `MCP call failed: ${message}` }],
                  };
                }
              },
            };
          },
          { name: toolId }
        );
      }
    }
  },
};

export default plugin;
