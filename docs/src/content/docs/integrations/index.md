---
title: Integrations
description: Connect Pinchy to external services and give agents access to real business data.
---

Integrations connect Pinchy to external systems so agents can work with real business data. An admin creates a connection once; from there, you control which agents can use it and exactly what they're allowed to do. No agent gets access unless you explicitly grant it.

## Available integrations

| Integration            | Connection method | Guide                                                              |
| ---------------------- | ----------------- | ------------------------------------------------------------------ |
| **Google (Gmail)**     | OAuth 2.0         | [Connect Email](/guides/connect-email/)                            |
| **Odoo**               | API key           | [Connect Odoo](/guides/connect-odoo/)                              |
| **Web Search (Brave)** | API key           | [Set Up Web Search](/guides/web-search-setup/)                     |
| **GitHub MCP**         | Bearer token      | [Connect GitHub MCP](/integrations/mcp/connect-github/)            |
| **Generic MCP**        | Bearer token      | [Connect a Generic MCP Server](/integrations/mcp/connect-generic/) |

## MCP integrations

MCP (Model Context Protocol) lets you connect agents to any MCP-compatible server — including GitHub, Notion, Linear, and your own custom servers. Permissions work at the individual tool level: you choose exactly which tools each agent can call. No tool access is granted by default.

MCP integrations require the `PINCHY_MCP_ENABLED=1` environment variable. See the [MCP Reference](/integrations/mcp/reference/) for the data model, audit events, and security details.

## How connections and permissions work

Every integration follows the same pattern:

- **Connection** — a global setting an admin creates once. It stores the credentials and knows how to talk to the external system.
- **Permissions** — per-agent settings that control what each agent can do with that connection.

Creating a connection doesn't give any agent access. You must explicitly grant access in each agent's Permissions tab.

For a deeper explanation of how the permission model works across all integration types, see [Integrations](/concepts/integrations/).

:::note
**Integrations vs. Channels.** This page covers data integrations — how agents access external business systems. For communication channels (how users reach agents from outside the Pinchy web UI), see [Set Up Telegram](/guides/telegram-setup/). LLM providers are configured separately via [Manage LLM Providers](/guides/llm-providers/).
:::
