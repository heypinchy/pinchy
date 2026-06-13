// src/credential-cache.ts
var CredentialCache = class _CredentialCache {
  cache = /* @__PURE__ */ new Map();
  static TTL_MS = 5 * 60 * 1e3;
  // 5 minutes
  async get(connectionId, fetcher) {
    const entry = this.cache.get(connectionId);
    if (entry && entry.expiresAt > Date.now()) return entry.token;
    const token = await fetcher();
    this.cache.set(connectionId, { token, expiresAt: Date.now() + _CredentialCache.TTL_MS });
    return token;
  }
  invalidate(connectionId) {
    this.cache.delete(connectionId);
  }
};

// src/index.ts
async function fetchCredentials(apiBaseUrl, gatewayToken, connectionId) {
  const url = `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${gatewayToken}` }
  });
  if (!res.ok) {
    throw new Error(
      `pinchy-mcp: credential fetch failed for connection ${connectionId}: HTTP ${res.status}`
    );
  }
  const data = await res.json();
  if (!data.credentials?.token || typeof data.credentials.token !== "string") {
    throw new Error(
      `pinchy-mcp: credential response missing credentials.token for connection ${connectionId}`
    );
  }
  return data.credentials.token;
}
async function callMcpTool(url, toolName, args, token) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name: toolName, arguments: args }
    })
  });
  if (!res.ok) {
    const status = res.status;
    const err = new Error(`HTTP ${status}`);
    err.status = status;
    throw err;
  }
  const body = await res.json();
  if (body.error) {
    return {
      isError: true,
      content: [{ type: "text", text: `MCP error: ${body.error.message ?? "Unknown error"}` }]
    };
  }
  return {
    content: body.result?.content ?? [{ type: "text", text: "" }],
    isError: body.result?.isError
  };
}
var plugin = {
  id: "pinchy-mcp",
  name: "Pinchy MCP",
  description: "MCP (Model Context Protocol) server integration. Connects agents to external MCP servers, exposing their tools as native agent capabilities.",
  configSchema: {
    validate: (value) => {
      if (value && typeof value === "object" && "apiBaseUrl" in value && "gatewayToken" in value && "connections" in value && Array.isArray(value.connections)) {
        return { ok: true, value };
      }
      return {
        ok: false,
        errors: ["Missing required keys in pinchy-mcp config"]
      };
    }
  },
  register(api) {
    const config = api.pluginConfig;
    if (!config) return;
    const { apiBaseUrl, gatewayToken, connections } = config;
    const credCache = new CredentialCache();
    for (const connection of connections) {
      const { connectionId, url, toolPrefix, agentTools } = connection;
      const allToolNames = /* @__PURE__ */ new Set();
      for (const toolList of Object.values(agentTools)) {
        for (const toolName of toolList) {
          allToolNames.add(toolName);
        }
      }
      for (const toolName of allToolNames) {
        const toolId = `${toolPrefix}${toolName}`;
        api.registerTool(
          (ctx) => {
            const agentId = ctx.agentId;
            if (!agentId) return null;
            if (!agentTools[agentId]) return null;
            return {
              name: toolId,
              label: toolId.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase()),
              description: `Call the ${toolName} tool on the ${connection.preset} MCP server (connection: ${connectionId}).`,
              parameters: {
                type: "object",
                additionalProperties: true
              },
              async execute(_toolCallId, params) {
                const allowed = agentTools[agentId] ?? [];
                if (!allowed.includes(toolName)) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: `Tool "${toolName}" is not allowed for this agent. Check the agent's MCP tool permissions.`
                      }
                    ]
                  };
                }
                await new Promise((resolve) => setImmediate(resolve));
                let token;
                try {
                  token = await credCache.get(
                    connectionId,
                    () => fetchCredentials(apiBaseUrl, gatewayToken, connectionId)
                  );
                } catch (err) {
                  const message = err instanceof Error ? err.message : "Unknown error";
                  return {
                    isError: true,
                    content: [{ type: "text", text: `Credential fetch failed: ${message}` }]
                  };
                }
                try {
                  return await callMcpTool(url, toolName, params, token);
                } catch (err) {
                  const status = err.status;
                  if (status === 401) {
                    credCache.invalidate(connectionId);
                    try {
                      token = await credCache.get(
                        connectionId,
                        () => fetchCredentials(apiBaseUrl, gatewayToken, connectionId)
                      );
                      return await callMcpTool(url, toolName, params, token);
                    } catch (retryErr) {
                      const message2 = retryErr instanceof Error ? retryErr.message : "Unknown error";
                      return {
                        isError: true,
                        content: [{ type: "text", text: `MCP call failed after retry: ${message2}` }]
                      };
                    }
                  }
                  const message = err instanceof Error ? err.message : "Unknown error";
                  return {
                    isError: true,
                    content: [{ type: "text", text: `MCP call failed: ${message}` }]
                  };
                }
              }
            };
          },
          { name: toolId }
        );
      }
    }
  }
};
var index_default = plugin;
export {
  index_default as default
};
