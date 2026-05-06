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

interface EmailCredentials {
  accessToken: string;
}

/**
 * Defense-in-depth: fail fast with a clear error if the credentials API
 * returns the wrong shape (e.g. an unresolved SecretRef object instead
 * of a plain string accessToken — the bug class behind #209). Without
 * this assertion a malformed payload would propagate to the Gmail API
 * as `accessToken: undefined`, producing a confusing 401 that masks the
 * real cause.
 */
function assertCredentialsShape(creds: unknown): asserts creds is EmailCredentials {
  if (!creds || typeof creds !== "object") {
    throw new Error(`pinchy-email: credentials must be an object, got ${typeof creds}`);
  }
  const obj = creds as Record<string, unknown>;
  const looksLikeSecretRef =
    typeof obj.source === "string" &&
    typeof obj.provider === "string" &&
    typeof obj.id === "string";
  const actual = typeof obj.accessToken;
  if (actual !== "string") {
    const hint = looksLikeSecretRef
      ? " (the credentials API returned an unresolved SecretRef — see #209)"
      : actual === "object"
        ? " (looks like an unresolved SecretRef — see #209)"
        : "";
    throw new Error(
      `pinchy-email: credentials.accessToken must be a string, got ${actual}${hint}`,
    );
  }
}

async function fetchCredentials(
  apiBaseUrl: string,
  gatewayToken: string,
  connectionId: string,
): Promise<EmailCredentials> {
  const response = await fetch(
    `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials`,
    { headers: { Authorization: `Bearer ${gatewayToken}` } },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch credentials: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { credentials?: unknown };
  assertCredentialsShape(data.credentials);
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

    // GmailAdapter cache per agent. Built lazily on first tool call:
    // fetch credentials from Pinchy → instantiate GmailAdapter. TTL keeps
    // the cache fresh enough that token rotation propagates within
    // CREDENTIALS_TTL_MS without anyone restarting OpenClaw — and on a
    // 401 from Gmail (which happens immediately after the access token
    // expires, since the Pinchy-side OAuth refresh races the call) we
    // invalidate eagerly and refetch once before surfacing the error.
    const CREDENTIALS_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const cache = new Map<string, { gmail: GmailAdapter; expiresAt: number }>();

    function invalidate(agentId: string) {
      cache.delete(agentId);
    }

    async function getOrCreateClient(
      agentId: string,
      config: AgentEmailConfig,
    ): Promise<GmailAdapter> {
      const hit = cache.get(agentId);
      if (hit && hit.expiresAt > Date.now()) return hit.gmail;
      const creds = await fetchCredentials(apiBaseUrl, gatewayToken, config.connectionId);
      const gmail = new GmailAdapter({ accessToken: creds.accessToken });
      cache.set(agentId, { gmail, expiresAt: Date.now() + CREDENTIALS_TTL_MS });
      return gmail;
    }

    /**
     * Run a Gmail call with one transparent retry on auth failure.
     * Gmail returns a 401 (or "Invalid Credentials") when the access
     * token is stale. Pinchy's credentials API auto-refreshes Google
     * OAuth tokens server-side, so on a 401 we invalidate the local
     * cache, refetch (which triggers the refresh), and retry once.
     */
    async function withAuthRetry<T>(
      agentId: string,
      config: AgentEmailConfig,
      fn: (gmail: GmailAdapter) => Promise<T>,
    ): Promise<T> {
      const gmail = await getOrCreateClient(agentId, config);
      try {
        return await fn(gmail);
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : "";
        const isAuthError =
          msg.includes("401") ||
          msg.includes("invalid credentials") ||
          msg.includes("invalid_grant") ||
          msg.includes("token has been expired") ||
          msg.includes("unauthorized");
        if (!isAuthError) throw err;
        invalidate(agentId);
        const fresh = await getOrCreateClient(agentId, config);
        return fn(fresh);
      }
    }

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

              const result = await withAuthRetry(agentId, config, (gmail) =>
                gmail.list({
                  folder: params.folder as string | undefined,
                  limit: params.limit as number | undefined,
                  unreadOnly: params.unreadOnly as boolean | undefined,
                }),
              );

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

              const result = await withAuthRetry(agentId, config, (gmail) =>
                gmail.read(params.id as string),
              );

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

              const result = await withAuthRetry(agentId, config, (gmail) =>
                gmail.search({
                  query: params.query as string,
                  limit: params.limit as number | undefined,
                }),
              );

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

              const result = await withAuthRetry(agentId, config, (gmail) =>
                gmail.draft({
                  to: params.to as string,
                  subject: params.subject as string,
                  body: params.body as string,
                  replyTo: params.replyTo as string | undefined,
                }),
              );

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

              const result = await withAuthRetry(agentId, config, (gmail) =>
                gmail.send({
                  to: params.to as string,
                  subject: params.subject as string,
                  body: params.body as string,
                  replyTo: params.replyTo as string | undefined,
                }),
              );

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
