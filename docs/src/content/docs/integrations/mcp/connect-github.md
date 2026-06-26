---
title: Connect GitHub MCP
description: Connect Pinchy to GitHub's MCP server so your agents can manage pull requests, issues, and repositories.
---

This guide walks you through connecting Pinchy to GitHub's MCP server. Once connected, you can grant agents the ability to open issues, review pull requests, list repositories, and more — with fine-grained control over exactly which tools each agent can use.

## Prerequisites

- Pinchy is running with the MCP feature enabled (`PINCHY_MCP_ENABLED=1` — see [Reference](/integrations/mcp/reference/))
- You're logged in as an admin in Pinchy
- A GitHub account with access to the repositories you want agents to work with

## 1. Create a GitHub Fine-Grained Personal Access Token

Pinchy connects to GitHub's MCP server using a Fine-Grained Personal Access Token (PAT). This token determines which repositories the agent can access and what it can do.

1. Go to [github.com/settings/personal-access-tokens/new](https://github.com/settings/personal-access-tokens/new)
2. Give the token a name (e.g. "Pinchy agent")
3. Set an expiration — we recommend 90 days and rotating on a schedule
4. Under **Repository access**, select the repositories your agent should work with
5. Under **Permissions**, grant:

   | Permission        | Access level   | Required for                   |
   | ----------------- | -------------- | ------------------------------ |
   | **Contents**      | Read           | Listing files and reading code |
   | **Pull requests** | Read and write | Reviewing and updating PRs     |
   | **Issues**        | Read and write | Creating and updating issues   |

6. Click **Generate token** and copy the value — you won't see it again

:::note
The token determines what the agent _can_ access at the GitHub level. Pinchy adds another layer: you also choose which MCP tools each agent is allowed to use. A token with broad permissions combined with a narrow tool allow-list is a good default posture.
:::

## 2. Add the connection in Pinchy

1. Go to **Settings → Integrations**
2. Click **Add Integration** and select **GitHub**
3. The URL (`https://api.githubcopilot.com/mcp/`) and transport (HTTP) are pre-filled — leave them as-is
4. Paste your PAT into the **Token** field
5. Click **Test connection and save**

Pinchy connects to GitHub's MCP server, discovers the available tools, and saves the connection. If the token is invalid or lacks required permissions, you'll see an error — check the token scopes and try again.

## 3. Grant agent access

A connection alone doesn't give any agent access. You need to grant specific tools per agent.

1. Open the agent you want to connect to GitHub
2. Click the gear icon to open **Agent Settings**
3. Select the **Permissions** tab
4. Find the GitHub connection and check the tools this agent may use
5. Click **Save**

Start with a minimal set. You can always add more tools later — it's easier to expand access than to explain why an agent took an action you didn't expect.

## 4. Test it

Open the agent's chat and try a few requests:

- "List open pull requests in the repo"
- "Create an issue titled 'Update dependencies' in the project"
- "What's the status of PR #42?"

If something doesn't work, check that the token's repository access and permission scopes match what the agent is trying to do.

## Rotating the token

When your token expires or you want to rotate it:

1. Go to **Settings → Integrations**
2. Select the GitHub connection
3. Click **Edit** and paste the new token
4. Click **Save**

Pinchy stores tokens encrypted — the old token is immediately replaced.

## Troubleshooting

**"Connection failed: 401 Unauthorized"** — The token is invalid or expired. Generate a new PAT and update the connection.

**"Connection failed: 403 Forbidden"** — The token doesn't have the required permissions for the repositories you're trying to access. Check the repository access and permission scopes.

**Tool not available after connecting** — GitHub may add or change MCP tools. Use **Re-sync** (Settings → Integrations → select connection) to refresh the tool list.

**Agent returns an error when using a tool** — Verify the agent has been granted that tool in the Permissions tab. Pinchy enforces the allow-list — the agent cannot call tools it hasn't been granted, even if the token would technically allow it.

## What's next

- [MCP Reference](/integrations/mcp/reference/) — data model, audit events, and security details
- [Connect a Generic MCP Server](/integrations/mcp/connect-generic/) — connect any MCP-compatible server
- [Agent Permissions](/concepts/agent-permissions/) — how the tool allow-list works
