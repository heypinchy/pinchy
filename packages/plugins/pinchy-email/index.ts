import { GmailAdapter } from "./gmail-adapter.js";
import { GraphAdapter } from "./graph-adapter.js";
import type { EmailAdapter } from "./email-adapter.js";
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

/**
 * Best-effort POST to Pinchy's report-auth-failure endpoint when a
 * retry-once cycle fails with a permanent auth error. This lets Pinchy
 * surface a clear "re-authorise" banner to admins rather than requiring
 * them to trawl through agent error messages.
 *
 * Errors are swallowed — never mask the original tool error.
 */
async function reportAuthFailure(
  apiBaseUrl: string,
  connectionId: string,
  gatewayToken: string,
  reason: string,
): Promise<void> {
  try {
    await fetch(
      `${apiBaseUrl}/api/internal/integrations/${connectionId}/report-auth-failure`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${gatewayToken}`,
          "Content-Type": "application/json",
          "X-Plugin-Id": "pinchy-email",
        },
        body: JSON.stringify({ reason: reason.slice(0, 500) }),
      },
    );
  } catch {
    // best-effort — never mask the original tool error
  }
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
): Promise<{ type: string; credentials: EmailCredentials }> {
  const response = await fetch(
    `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials`,
    { headers: { Authorization: `Bearer ${gatewayToken}` } },
  );

  if (!response.ok) {
    throw new Error(
      `Failed to fetch credentials: ${response.status} ${response.statusText}`,
    );
  }

  const data = (await response.json()) as { type?: unknown; credentials?: unknown };
  if (!data.type || typeof data.type !== "string") {
    throw new Error(
      `pinchy-email: credentials API returned no type field (got ${JSON.stringify((data as { type?: unknown }).type)})`,
    );
  }
  assertCredentialsShape(data.credentials);
  return { type: data.type, credentials: data.credentials };
}

const plugin = {
  id: "pinchy-email",
  name: "Pinchy Email",
  description: "Email integration (Gmail and Microsoft 365) with per-agent permissions.",

  register(api: PluginApi) {
    // Read api.pluginConfig dynamically on each factory/execute call rather than
    // capturing it once at register() time. OpenClaw may call register() before
    // plugins.entries.pinchy-email is fully applied during a hot-reload that adds
    // the plugin for the first time, leaving a stale empty agentConfigs in the
    // closure. Dynamic access via api.pluginConfig ensures the factory always sees
    // the current config when OpenClaw invokes it per chat session.
    console.log(
      `[pinchy-email] register() called — agents: ${JSON.stringify(Object.keys(api.pluginConfig?.agents ?? {}))}`,
    );

    // EmailAdapter cache per agent. Built lazily on first tool call:
    // fetch credentials from Pinchy → instantiate the appropriate adapter
    // based on credentials.type. TTL keeps the cache fresh enough that
    // token rotation propagates within CREDENTIALS_TTL_MS without anyone
    // restarting OpenClaw — and on a 401 from the provider (which happens
    // immediately after the access token expires, since the Pinchy-side
    // OAuth refresh races the call) we invalidate eagerly and refetch once
    // before surfacing the error.
    const CREDENTIALS_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const cache = new Map<string, { adapter: EmailAdapter; expiresAt: number }>();

    function invalidate(agentId: string) {
      cache.delete(agentId);
    }

    async function getOrCreateClient(
      agentId: string,
      config: AgentEmailConfig,
    ): Promise<EmailAdapter> {
      const hit = cache.get(agentId);
      if (hit && hit.expiresAt > Date.now()) return hit.adapter;
      // Read apiBaseUrl and gatewayToken dynamically so they reflect any
      // config update that arrived after the initial register() call.
      const apiBaseUrl = api.pluginConfig?.apiBaseUrl ?? "";
      const gatewayToken = api.pluginConfig?.gatewayToken ?? "";
      const { type, credentials: creds } = await fetchCredentials(
        apiBaseUrl,
        gatewayToken,
        config.connectionId,
      );
      const adapter: EmailAdapter =
        type === "microsoft"
          ? new GraphAdapter({ accessToken: creds.accessToken })
          : type === "google"
            ? new GmailAdapter({ accessToken: creds.accessToken })
            : (() => {
                throw new Error(`unsupported email provider: ${type}`);
              })();
      cache.set(agentId, { adapter, expiresAt: Date.now() + CREDENTIALS_TTL_MS });
      return adapter;
    }

    /**
     * Run an email adapter call with one transparent retry on auth failure.
     * The provider returns a 401 (or "Invalid Credentials") when the access
     * token is stale. Pinchy's credentials API auto-refreshes OAuth tokens
     * server-side, so on a 401 we invalidate the local cache, refetch
     * (which triggers the refresh), and retry once.
     */
    async function withAuthRetry<T>(
      agentId: string,
      config: AgentEmailConfig,
      fn: (adapter: EmailAdapter) => Promise<T>,
    ): Promise<T> {
      const adapter = await getOrCreateClient(agentId, config);
      try {
        return await fn(adapter);
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
        try {
          return await fn(fresh);
        } catch (retryErr) {
          const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
          await reportAuthFailure(apiBaseUrl, config.connectionId, gatewayToken, retryMsg);
          throw retryErr;
        }
      }
    }

    // 1. email_list
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(api.pluginConfig?.agents ?? {}, agentId);
        console.log(
          `[pinchy-email] email_list factory — agentId=${agentId} configured=${config !== null} known=${JSON.stringify(Object.keys(api.pluginConfig?.agents ?? {}))}`,
        );
        if (!config) return null;

        return {
          name: "email_list",
          label: "Email List",
          description:
            "List emails from a mailbox folder. Returns email summaries with sender, subject, date, and snippet. Canonical folder names: INBOX, SENT, DRAFTS, TRASH, SPAM.",
          parameters: {
            type: "object",
            properties: {
              folder: {
                type: "string",
                enum: ["INBOX", "SENT", "DRAFTS", "TRASH", "SPAM"],
                description:
                  "Canonical folder name to list (INBOX, SENT, DRAFTS, TRASH, SPAM). Defaults to INBOX.",
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

              const result = await withAuthRetry(agentId, config, (adapter) =>
                adapter.list({
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
        const config = getAgentConfig(api.pluginConfig?.agents ?? {}, agentId);
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

              const result = await withAuthRetry(agentId, config, (adapter) =>
                adapter.read(params.id as string),
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
        const config = getAgentConfig(api.pluginConfig?.agents ?? {}, agentId);
        if (!config) return null;

        return {
          name: "email_search",
          label: "Email Search",
          description:
            "Search emails using structured DSL fields. All fields are optional — combine them to narrow results. Canonical folder names: INBOX, SENT, DRAFTS, TRASH, SPAM.",
          parameters: {
            type: "object",
            properties: {
              from: {
                type: "string",
                description: "Filter by sender email address",
              },
              to: {
                type: "string",
                description: "Filter by recipient email address",
              },
              subject: {
                type: "string",
                description: "Filter by subject text",
              },
              unread: {
                type: "boolean",
                description: "If true, return only unread emails",
              },
              sinceDays: {
                type: "number",
                description: "Return emails newer than this many days",
              },
              folder: {
                type: "string",
                enum: ["INBOX", "SENT", "DRAFTS", "TRASH", "SPAM"],
                description:
                  "Canonical folder name to scope the search (INBOX, SENT, DRAFTS, TRASH, SPAM)",
              },
              limit: {
                type: "number",
                description: "Maximum number of results (default: 20)",
              },
            },
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              if (!checkPermission(config.permissions, "email", "read")) {
                return permissionDenied("read");
              }

              const result = await withAuthRetry(agentId, config, (adapter) =>
                adapter.search({
                  from: params.from as string | undefined,
                  to: params.to as string | undefined,
                  subject: params.subject as string | undefined,
                  unread: params.unread as boolean | undefined,
                  sinceDays: params.sinceDays as number | undefined,
                  folder: params.folder as
                    | "INBOX"
                    | "SENT"
                    | "DRAFTS"
                    | "TRASH"
                    | "SPAM"
                    | undefined,
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
        const config = getAgentConfig(api.pluginConfig?.agents ?? {}, agentId);
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

              const result = await withAuthRetry(agentId, config, (adapter) =>
                adapter.draft({
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
        const config = getAgentConfig(api.pluginConfig?.agents ?? {}, agentId);
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

              const result = await withAuthRetry(agentId, config, (adapter) =>
                adapter.send({
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
