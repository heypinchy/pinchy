---
title: MCP Integrations Reference
description: Data model, permission model, audit events, security boundary, and transport details for MCP integrations.
---

This page is the technical reference for MCP integrations in Pinchy. For step-by-step setup, see [Connect GitHub MCP](/integrations/mcp/connect-github/) or [Connect a Generic MCP Server](/integrations/mcp/connect-generic/).

## Feature flag

MCP integrations are behind a feature flag. Set `PINCHY_MCP_ENABLED=1` in your environment to enable them.

When the flag is off, the MCP preset options don't appear in the UI and the MCP-related API routes return 404. No data is lost — existing connections and permissions are preserved and become active again when the flag is re-enabled.

## Supported transports

| Transport | Description                                                                                      | When to use                             |
| --------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| **HTTP**  | Streamable HTTP — the standard MCP transport. Pinchy opens a stateless HTTP connection per call. | Most MCP servers — use this by default. |
| **SSE**   | Server-Sent Events — a persistent connection where the server streams responses.                 | Servers that explicitly require SSE.    |

OAuth and stdio transports are not supported in Phase 1.

## Data model

### `integrationConnections` table

MCP connections are stored in the same `integrationConnections` table as other integration types. The `type` column is `"mcp"` and the `data` column holds a JSON object with MCP-specific fields.

```ts
type McpIntegrationData = {
  type: "mcp";
  preset: "github" | "notion" | "linear" | "generic";
  transport: "http" | "sse";
  url: string;
  tools: McpTool[];
  lastSyncedAt: string; // ISO 8601
};

type McpTool = {
  name: string;
  description: string;
  inputSchema: object;
};
```

The `tools` array is populated at connection time and updated on each re-sync. It reflects the tool list the MCP server exposed at last contact.

Credentials (bearer tokens) are **not** stored in `data`. They are encrypted with AES-256-GCM and stored in the `credentials` column, decrypted on-demand when the plugin needs them.

### `agentMcpToolPermissions` table

Tool-level permissions are tracked separately from connection-level permissions. Each row grants one agent access to one tool on one connection.

| Column         | Type      | Description                                      |
| -------------- | --------- | ------------------------------------------------ |
| `id`           | text      | UUID primary key                                 |
| `agentId`      | text      | References `agents.id` (cascade delete)          |
| `connectionId` | text      | References `integrationConnections.id` (cascade) |
| `toolName`     | text      | Exact tool name as reported by the MCP server    |
| `createdAt`    | timestamp | When this permission was granted                 |

A unique constraint on `(agentId, connectionId, toolName)` prevents duplicates.

## Permission model

MCP permissions are tool-level, not operation-level. This is different from integrations like Odoo (which use operation-level permissions like "read" or "write") or Gmail (which use permission tiers like "read → draft → send").

The flow:

1. An admin creates an MCP connection. Pinchy discovers the tool list from the server.
2. The admin opens an agent's Permissions tab and checks specific tools.
3. Pinchy writes a row per tool into `agentMcpToolPermissions`.
4. OpenClaw is reconfigured with the new allow-list via `regenerateOpenClawConfig()`.
5. OpenClaw enforces the allow-list at dispatch — each agent's `tools.allow` policy lists exactly the granted `<server>__<tool>` names, so the agent can only invoke tools it has been explicitly granted. Calls to ungranted tools are never dispatched.

Creating a connection does not grant any agent access. Access is always explicit.

## OpenClaw config emission

Pinchy never writes third-party credentials into the OpenClaw config file. It emits OpenClaw's native `mcp.servers` block, pointed at Pinchy's internal credential-injecting proxy rather than the upstream MCP server:

```json
{
  "mcp": {
    "servers": {
      "m7bbfbc51...": {
        "url": "https://your-pinchy-instance/api/internal/mcp-proxy/conn_abc",
        "transport": "streamable-http",
        "headers": { "Authorization": "Bearer <gateway-bootstrap-token>" }
      }
    }
  },
  "agents": {
    "list": [
      {
        "id": "agent_xyz",
        "tools": {
          "allow": ["m7bbfbc51...__create_issue", "m7bbfbc51...__list_repos"]
        }
      }
    ]
  }
}
```

OpenClaw connects to the proxy URL and discovers and materializes the server's tools per run. When a tool is called, the proxy authenticates the gateway token, fetches the connection's bearer token from Pinchy's encrypted store, injects it as `Authorization: Bearer …`, and forwards the request to the upstream MCP server. The third-party token therefore never appears in `openclaw.json` — only the gateway bootstrap token does (the trust root OpenClaw already uses).

This matches [Pattern B](/security/secrets/) from Pinchy's secret-handling architecture — runtime credential fetch with no secret at rest, applied at the transport layer.

## Audit events

Every state-changing MCP operation is recorded in the audit trail. All audit rows are HMAC-SHA256 signed.

### `config.changed` — integration created

Fired when an MCP connection is successfully created.

```json
{
  "eventType": "config.changed",
  "resource": "integration:<connectionId>",
  "detail": {
    "action": "integration_created",
    "type": "mcp",
    "name": "<connection name>",
    "mcp": {
      "preset": "github",
      "transport": "http",
      "url": "https://api.githubcopilot.com/mcp/",
      "toolCount": 12
    }
  },
  "outcome": "success"
}
```

If discovery fails (the server is unreachable or returns an error), the connection is **not** saved and the audit record has `outcome: "failure"` with the error detail.

### `config.changed` — tools re-synced

Fired when a connection's tool list is refreshed via the Re-sync action.

```json
{
  "eventType": "config.changed",
  "resource": "integration:<connectionId>",
  "detail": {
    "action": "integration_mcp_synced",
    "id": "<connectionId>",
    "name": "<connection name>",
    "tools": {
      "added": ["new_tool"],
      "removed": ["old_tool"],
      "total": 13
    }
  },
  "outcome": "success"
}
```

Removed tools trigger a cascade delete of agent permission rows in the same database transaction.

### `agent.updated` — tool permissions changed

Fired when an agent's MCP tool allow-list is modified via the Permissions tab.

```json
{
  "eventType": "agent.updated",
  "resource": "agent:<agentId>",
  "detail": {
    "changes": {
      "mcpTools": {
        "connectionId": "<connectionId>",
        "connectionName": "<connection name>",
        "added": ["create_issue"],
        "removed": ["legacy_search"]
      }
    }
  },
  "outcome": "success"
}
```

## Security boundary

MCP integrations follow the same security posture as all other Pinchy integrations:

- **Encryption at rest** — bearer tokens are encrypted with AES-256-GCM before storage. They never appear in logs, config files, or API responses.
- **No credentials in OpenClaw config** — Pinchy's credential proxy fetches tokens on-demand from its encrypted store and injects them at request time. The emitted `openclaw.json` contains no third-party secret material (only the gateway bootstrap token).
- **SSRF protection** — Pinchy validates MCP server URLs both at connection time and again in the proxy before every request, blocking internal network addresses and localhost. This prevents agents from being used to probe your internal infrastructure.
- **Tool-level allow-list** — OpenClaw's per-agent tool policy (`tools.allow`) gates which materialized MCP tools an agent can call. An agent cannot call a tool it hasn't been explicitly granted, even if the underlying token would technically allow it.
- **Audit coverage** — connection creation, re-syncs, and permission changes are all audited with `outcome` set on every entry.
- **Plaintext scanner** — `regenerateOpenClawConfig()` runs the built-in plaintext scanner against the generated config and fails fast if any known token prefix (e.g. `ghp_`, `secret_`, `lin_api_`) appears in the output.

## Presets

Presets pre-fill the URL and transport for known MCP servers and show token instructions in the connection dialog.

| Preset      | Default URL                          | Transport | Token type            |
| ----------- | ------------------------------------ | --------- | --------------------- |
| **GitHub**  | `https://api.githubcopilot.com/mcp/` | HTTP      | Fine-Grained PAT      |
| **Notion**  | Notion's MCP endpoint                | HTTP      | Notion internal token |
| **Linear**  | Linear's MCP endpoint                | HTTP      | Linear API key        |
| **Generic** | _(none — you provide the URL)_       | HTTP      | Any bearer token      |

Presets are UI conveniences only. Under the hood, all MCP connections use the same data model and follow the same security boundary regardless of preset.
