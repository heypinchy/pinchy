---
title: Connect a Generic MCP Server
description: Connect any MCP-compatible server to Pinchy so your agents can use its tools.
---

This guide walks you through connecting any MCP-compatible server to Pinchy. Use this when you're running your own MCP server, connecting a third-party service that isn't one of the built-in presets, or testing a local MCP implementation.

## Prerequisites

- Pinchy is running with the MCP feature enabled (`PINCHY_MCP_ENABLED=1` — see [Reference](/integrations/mcp/reference/))
- You're logged in as an admin in Pinchy
- An MCP server you want to connect, with a known URL and an authentication token

## What you'll need from your MCP server

Before starting, gather:

| Detail        | What it is                                                            |
| ------------- | --------------------------------------------------------------------- |
| **URL**       | The full server URL (e.g. `https://mcp.yourcompany.com/`)             |
| **Transport** | `HTTP` (Streamable HTTP) or `SSE` — check your server's documentation |
| **Token**     | The bearer token used to authenticate requests                        |

Most MCP servers use HTTP transport. Use SSE only if your server explicitly requires it.

## 1. Add the connection in Pinchy

1. Go to **Settings → Integrations**
2. Click **Add Integration** and select **Generic MCP**
3. Fill in:
   - **Name** — a descriptive name for this connection (e.g. "Internal Knowledge MCP")
   - **URL** — the server URL
   - **Transport** — HTTP or SSE
   - **Token** — your bearer token
4. Click **Test connection** to verify Pinchy can reach the server and discover its tools

The test step is optional but we recommend it — it shows the tool list before you save, so you can confirm the right server is connected and the token works.

5. Click **Test connection and save**

Pinchy connects to the server, discovers the available tools, and saves the connection. If discovery fails (the server is unreachable, the token is wrong, or the server returns an error), Pinchy won't save the connection — fix the issue and try again.

## 2. Review the tool list

After a successful connection, Pinchy shows the tools the server exposed. Review them — the names and descriptions come directly from the server. If the list looks wrong, check that you're pointing at the right URL and that the token has the right access.

## 3. Grant agent access

A connection alone doesn't give any agent access. You need to grant specific tools per agent.

1. Open the agent you want to connect to this server
2. Click the gear icon to open **Agent Settings**
3. Select the **Permissions** tab
4. Find the connection and check the tools this agent may use
5. Click **Save**

Grant only the tools the agent actually needs. The allow-list is enforced by Pinchy — the agent cannot call tools it hasn't been explicitly granted.

## 4. Test it

Open the agent's chat and ask it to use one of the tools you granted. If the agent doesn't respond as expected, check:

- The tool is checked in the agent's Permissions tab
- The server is reachable from your Pinchy instance
- The token hasn't expired

## Keeping the tool list current

MCP servers can add, rename, or remove tools over time. When that happens, your agent's allow-list may become stale.

To re-sync: go to **Settings → Integrations**, select the connection, and click **Re-sync**. Pinchy re-discovers the tool list and removes any agent permissions for tools that no longer exist.

:::note
Re-syncing cleans up stale permissions automatically. You'll need to manually grant access to any newly added tools — Pinchy doesn't auto-grant tools to agents.
:::

## Troubleshooting

**"Connection failed: could not reach server"** — Verify the URL is correct and the server is running. If Pinchy is running inside Docker and the MCP server is on your local machine, use the Docker host address instead of `localhost`.

**"Connection failed: 401 Unauthorized"** — The token is invalid. Double-check it and try again.

**"Connection failed: invalid tool schema"** — The server returned a tool definition Pinchy couldn't parse. This usually means the server isn't fully MCP-compliant. Check the server's documentation or contact its maintainer.

**Agent can't use a tool after connecting** — Confirm the tool is checked in the agent's Permissions tab. Tools must be explicitly granted — a connection doesn't automatically give any agent access.

**Tools disappeared after a re-sync** — The MCP server removed or renamed those tools. Any agent permissions for removed tools are automatically cleaned up. You'll see a notification in the UI if tools that agents were using are gone.

## What's next

- [MCP Reference](/integrations/mcp/reference/) — data model, audit events, and security details
- [Connect GitHub MCP](/integrations/mcp/connect-github/) — GitHub-specific setup with PAT scopes
- [Agent Permissions](/concepts/agent-permissions/) — how the tool allow-list works
