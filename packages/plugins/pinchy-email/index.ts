import { GmailAdapter } from "./gmail-adapter.js";
import { checkPermission, type Permissions } from "./permissions.js";

interface PluginToolContext {
  agentId?: string;
}

interface ContentBlock {
  type: string;
  text: string;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  registerTool: (
    factory: (ctx: PluginToolContext) => AgentTool | null,
    opts?: { name?: string },
  ) => void;
}

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{ content: ContentBlock[]; isError?: boolean }>;
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<
    string,
    {
      connectionId: string;
      permissions: Permissions;
    }
  >;
}

interface AgentEmailConfig {
  connectionId: string;
  permissions: Permissions;
}

function getAgentConfig(
  agentConfigs: Record<string, AgentEmailConfig>,
  agentId: string,
): AgentEmailConfig | null {
  return agentConfigs[agentId] ?? null;
}

function permissionDenied(operation: string): {
  content: ContentBlock[];
  isError: true;
} {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Permission denied: email.${operation} is not allowed for this agent.`,
      },
    ],
  };
}

function errorResult(error: unknown): {
  content: ContentBlock[];
  isError: true;
} {
  const message = error instanceof Error ? error.message : "Unknown error";
  return {
    isError: true,
    content: [{ type: "text", text: `Error: ${message}` }],
  };
}

async function fetchCredentials(
  apiBaseUrl: string,
  gatewayToken: string,
  connectionId: string,
): Promise<{ accessToken: string }> {
  const response = await fetch(
    `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials`,
    { headers: { Authorization: `Bearer ${gatewayToken}` } },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch credentials: ${response.status} ${response.statusText}`,
    );
  }

  const data = await response.json();
  return data.credentials;
}

const plugin = {
  id: "pinchy-email",
  name: "Pinchy Email",
  description: "Email integration (Gmail) with per-agent permissions.",

  register(api: PluginApi) {
    const pluginConfig = api.pluginConfig;
    const agentConfigs = pluginConfig?.agents ?? {};
    const apiBaseUrl = pluginConfig?.apiBaseUrl ?? "";
    const gatewayToken = pluginConfig?.gatewayToken ?? "";

    // 1. email_list
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "email_list",
          label: "Email List",
          description:
            "List emails from a mailbox folder. Returns email summaries with sender, subject, date, and snippet. Use folder parameter for specific folders (INBOX, SENT, DRAFTS) and unreadOnly to filter unread messages.",
          parameters: {
            type: "object",
            properties: {
              folder: {
                type: "string",
                description:
                  "Mailbox folder to list. E.g. 'INBOX', 'SENT', 'DRAFTS'. Defaults to INBOX.",
              },
              limit: {
                type: "number",
                description: "Maximum number of emails to return (default: 20)",
              },
              unreadOnly: {
                type: "boolean",
                description: "Only return unread emails (default: false)",
              },
            },
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              if (!checkPermission(config.permissions, "email", "read")) {
                return permissionDenied("read");
              }

              const credentials = await fetchCredentials(
                apiBaseUrl,
                gatewayToken,
                config.connectionId,
              );
              const gmail = new GmailAdapter({
                accessToken: credentials.accessToken,
              });

              const result = await gmail.list({
                folder: params.folder as string | undefined,
                limit: params.limit as number | undefined,
                unreadOnly: params.unreadOnly as boolean | undefined,
              });

              return {
                content: [
                  { type: "text", text: JSON.stringify(result, null, 2) },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "email_list" },
    );

    // 2. email_read
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "email_read",
          label: "Email Read",
          description:
            "Read the full content of a specific email by its ID. Returns complete email with body, headers, and metadata.",
          parameters: {
            type: "object",
            properties: {
              id: {
                type: "string",
                description: "The email message ID to read",
              },
            },
            required: ["id"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              if (!checkPermission(config.permissions, "email", "read")) {
                return permissionDenied("read");
              }

              const credentials = await fetchCredentials(
                apiBaseUrl,
                gatewayToken,
                config.connectionId,
              );
              const gmail = new GmailAdapter({
                accessToken: credentials.accessToken,
              });

              const result = await gmail.read(params.id as string);

              return {
                content: [
                  { type: "text", text: JSON.stringify(result, null, 2) },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "email_read" },
    );

    // 3. email_search
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "email_search",
          label: "Email Search",
          description:
            "Search emails using Gmail search syntax. Supports queries like 'from:user@example.com', 'subject:invoice', 'is:unread', 'newer_than:7d', and combinations.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description:
                  "Gmail search query. E.g. 'from:user@example.com subject:invoice'",
              },
              limit: {
                type: "number",
                description: "Maximum number of results (default: 20)",
              },
            },
            required: ["query"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              if (!checkPermission(config.permissions, "email", "read")) {
                return permissionDenied("read");
              }

              const credentials = await fetchCredentials(
                apiBaseUrl,
                gatewayToken,
                config.connectionId,
              );
              const gmail = new GmailAdapter({
                accessToken: credentials.accessToken,
              });

              const result = await gmail.search({
                query: params.query as string,
                limit: params.limit as number | undefined,
              });

              return {
                content: [
                  { type: "text", text: JSON.stringify(result, null, 2) },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "email_search" },
    );

    // 4. email_draft
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "email_draft",
          label: "Email Draft",
          description:
            "Create a draft email. The draft is saved but NOT sent. Use replyTo to create a reply to an existing message.",
          parameters: {
            type: "object",
            properties: {
              to: { type: "string", description: "Recipient email address" },
              subject: { type: "string", description: "Email subject line" },
              body: {
                type: "string",
                description: "Email body text (plain text)",
              },
              replyTo: {
                type: "string",
                description:
                  "Message ID to reply to (optional). Sets In-Reply-To header.",
              },
            },
            required: ["to", "subject", "body"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              if (!checkPermission(config.permissions, "email", "draft")) {
                return permissionDenied("draft");
              }

              const credentials = await fetchCredentials(
                apiBaseUrl,
                gatewayToken,
                config.connectionId,
              );
              const gmail = new GmailAdapter({
                accessToken: credentials.accessToken,
              });

              const result = await gmail.draft({
                to: params.to as string,
                subject: params.subject as string,
                body: params.body as string,
                replyTo: params.replyTo as string | undefined,
              });

              return {
                content: [
                  { type: "text", text: JSON.stringify(result, null, 2) },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "email_draft" },
    );

    // 5. email_send
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "email_send",
          label: "Email Send",
          description:
            "Send an email immediately. WARNING: This sends the email right away — it cannot be undone. Use email_draft if you want to review before sending. Use replyTo to reply to an existing message.",
          parameters: {
            type: "object",
            properties: {
              to: { type: "string", description: "Recipient email address" },
              subject: { type: "string", description: "Email subject line" },
              body: {
                type: "string",
                description: "Email body text (plain text)",
              },
              replyTo: {
                type: "string",
                description:
                  "Message ID to reply to (optional). Sets In-Reply-To header.",
              },
            },
            required: ["to", "subject", "body"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              if (!checkPermission(config.permissions, "email", "send")) {
                return permissionDenied("send");
              }

              const credentials = await fetchCredentials(
                apiBaseUrl,
                gatewayToken,
                config.connectionId,
              );
              const gmail = new GmailAdapter({
                accessToken: credentials.accessToken,
              });

              const result = await gmail.send({
                to: params.to as string,
                subject: params.subject as string,
                body: params.body as string,
                replyTo: params.replyTo as string | undefined,
              });

              return {
                content: [
                  { type: "text", text: JSON.stringify(result, null, 2) },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "email_send" },
    );
  },
};

export default plugin;
