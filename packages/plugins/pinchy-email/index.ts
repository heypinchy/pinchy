import { mkdir, writeFile, access } from "node:fs/promises";
import { basename } from "node:path";
import { GmailAdapter } from "./gmail-adapter.js";
import { GraphAdapter } from "./graph-adapter.js";
import type { EmailAdapter, EmailSummary, Folder } from "./email-adapter.js";
import { checkPermission, type Permissions } from "./permissions.js";
import {
  putHandle,
  putAttachmentHandle,
  resolveHandle,
  MSG_PREFIX,
  ATT_PREFIX,
  MAX_ENTRIES_PER_AGENT,
} from "./id-handle-store.js";

// Filesystem convention shared with pinchy-odoo's odoo_attach_file: every
// agent's uploads land in the same per-agent directory so a downloaded email
// attachment can be handed off to odoo_attach_file by filename alone. This is
// NOT plugin config — do not add it to openclaw.plugin.json's configSchema.
const WORKSPACE_ROOT = "/root/.openclaw/workspaces";

// 25 MB matches odoo_attach_file's own cap (see packages/plugins/pinchy-odoo/index.ts),
// so anything saved here is always small enough to hand off downstream.
const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

const EXT_BY_MIME = new Map<string, string>([
  ["application/pdf", ".pdf"],
  ["image/jpeg", ".jpg"],
  ["image/png", ".png"],
  ["image/gif", ".gif"],
  ["image/webp", ".webp"],
  ["application/msword", ".doc"],
  [
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".docx",
  ],
  ["application/vnd.ms-excel", ".xls"],
  [
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".xlsx",
  ],
  ["text/plain", ".txt"],
  ["text/csv", ".csv"],
]);

function extensionForMimeType(mimeType: string | undefined): string {
  if (!mimeType) return ".bin";
  return EXT_BY_MIME.get(mimeType.toLowerCase()) ?? ".bin";
}

function humanReadableSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
}

/**
 * Strip anything that isn't a conservative safe-filename character, then
 * strip leading dots (hidden files / traversal remnants like ".."). Shared
 * by both sanitizeAttachmentFilename call sites below — the cleaned
 * filename and the attachmentId-derived fallback stem — so the two paths
 * can never drift apart. Keep this leading-dot strip if you touch it: the
 * defense-in-depth path check in email_get_attachment's execute() relies on
 * it (see the comment there) to route literal ".." / "." filenames into the
 * attachment-<id> fallback instead of ever reaching the write.
 */
function sanitizeNameToken(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "");
}

/**
 * Attachment filenames are attacker-controlled — the email sender picks
 * them, not the agent — so we SANITIZE rather than reject (unlike
 * odoo_attach_file's isSafeFilename, which rejects because there the agent
 * typed the name itself). Strips any path components and unsafe characters;
 * falls back to a generated name derived from the attachment id when
 * nothing safe survives.
 */
function sanitizeAttachmentFilename(
  rawFilename: string,
  attachmentId: string,
  mimeType: string | undefined,
): string {
  const base = basename((rawFilename ?? "").trim().replace(/\\/g, "/"));
  const cleaned = sanitizeNameToken(base);

  if (cleaned.length > 0) return cleaned;

  const shortId = sanitizeNameToken(attachmentId).slice(0, 16);
  const suffix = shortId.length > 0 ? shortId : "unknown";
  return `attachment-${suffix}${extensionForMimeType(mimeType)}`;
}

/** Split "name.ext" into ["name", ".ext"] (empty ext if none). */
function splitExtension(filename: string): [string, string] {
  const idx = filename.lastIndexOf(".");
  if (idx <= 0) return [filename, ""];
  return [filename.slice(0, idx), filename.slice(idx)];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Find a filename that doesn't already exist in `dir`, appending -1, -2, …
 * before the extension. Never overwrites — uploads/ is also the user's
 * chat-upload zone, so clobbering a user's file would be data loss.
 */
async function pickUniqueFilename(
  dir: string,
  filename: string,
): Promise<string> {
  const [stem, ext] = splitExtension(filename);
  let candidate = filename;
  let counter = 0;
  while (await pathExists(`${dir}/${candidate}`)) {
    counter += 1;
    candidate = `${stem}-${counter}${ext}`;
  }
  return candidate;
}

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
  ) => Promise<{
    content: ContentBlock[];
    isError?: boolean;
    details?: { error: string };
  }>;
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<
    string,
    {
      connectionId: string;
      permissions: Permissions;
      // Optional to match the manifest schema: pre-upgrade config entries were
      // written without a tools field, and the plugin never reads it (tool
      // gating is permissions-based).
      tools?: string[];
    }
  >;
}

interface AgentEmailConfig {
  connectionId: string;
  permissions: Permissions;
  tools?: string[];
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

/**
 * Audit-integrity contract (see packages/web/src/app/api/internal/audit/tool-use/route.ts
 * lines ~116-122, issue #404): OpenClaw's tool-use hook strips the MCP
 * `isError` flag before forwarding results to the audit route, so
 * `details.error` is often the only remaining failure signal. Every
 * error-returning path below must set it (identical string to
 * content[0].text), mirroring pinchy-odoo's toolError() helper.
 */
function toolError(text: string): {
  content: ContentBlock[];
  isError: true;
  details: { error: string };
} {
  return {
    isError: true,
    content: [{ type: "text", text }],
    details: { error: text },
  };
}

function permissionDenied(operation: string): {
  content: ContentBlock[];
  isError: true;
  details: { error: string };
} {
  return toolError(
    `Permission denied: email.${operation} is not allowed for this agent.`,
  );
}

function errorResult(error: unknown): {
  content: ContentBlock[];
  isError: true;
  details: { error: string };
} {
  const message = error instanceof Error ? error.message : "Unknown error";
  return toolError(`Error: ${message}`);
}

/**
 * Handle-indirection (Bug B, 2026-07-07 debugging session; sibling of PR
 * #668): resolve a model-supplied value into the real provider id before it
 * reaches the adapter.
 *
 * - If the value starts with our handle prefix (msg_/att_) and resolves,
 *   return the realId.
 * - If it starts with our prefix but does NOT resolve (unknown/expired/wrong
 *   agent), return a failed-tool-result telling the model to re-list.
 * - If it does not start with our prefix at all, treat it as a raw provider
 *   id (Gmail compatibility / graceful fallback) and pass it through
 *   unchanged.
 */
function resolveEmailReference(
  agentId: string,
  value: string,
):
  | { ok: true; realId: string }
  | { ok: false; result: ReturnType<typeof toolError> } {
  const isHandle =
    value.startsWith(`${MSG_PREFIX}_`) || value.startsWith(`${ATT_PREFIX}_`);
  if (!isHandle) return { ok: true, realId: value };

  const realId = resolveHandle(agentId, value);
  if (realId == null) {
    return {
      ok: false,
      result: toolError(
        `The email reference '${value}' is unknown or has expired. ` +
          `Call email_list or email_search again to get a fresh reference.`,
      ),
    };
  }
  return { ok: true, realId };
}

/** Replace each summary's raw id with a per-agent handle, minting one as needed. */
function handleizeSummaries(
  agentId: string,
  summaries: EmailSummary[],
): EmailSummary[] {
  return summaries.map((s) => ({
    ...s,
    id: putHandle(agentId, s.id),
  }));
}

/**
 * Clamp a model-supplied list/search limit to the handle store's per-agent
 * cap. Each returned summary mints a handle, and the store evicts oldest-first
 * once an agent exceeds the cap — so a single result set larger than the cap
 * would evict its own earliest handles, leaving the top rows the model was just
 * shown unresolvable and un-re-listable (Finding 1, 2026-07-07 review). Capping
 * the result set at the store size keeps every handle in a single listing
 * resolvable. A missing or non-positive limit is left undefined so the adapter
 * applies its own default — a zero or negative $top/maxResults would otherwise
 * reach the provider and yield a confusing empty result or a 400.
 */
function clampListLimit(limit: unknown): number | undefined {
  if (typeof limit !== "number" || !Number.isFinite(limit) || limit <= 0)
    return undefined;
  return Math.min(limit, MAX_ENTRIES_PER_AGENT);
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
function assertCredentialsShape(
  creds: unknown,
): asserts creds is EmailCredentials {
  if (!creds || typeof creds !== "object") {
    throw new Error(
      `pinchy-email: credentials must be an object, got ${typeof creds}`,
    );
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

/**
 * Thrown by fetchCredentials when the credentials API responds non-ok.
 * Carries `status` so callers (withAuthRetry) can discriminate the
 * settings-missing 503 case from transient errors without string-matching
 * the message.
 */
class CredentialsFetchError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CredentialsFetchError";
    this.status = status;
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
    // The route's error responses (e.g. 503 when OAuth settings are missing —
    // see OAuthSettingsMissingError in the credentials route) carry an
    // actionable message in the JSON body. Read it tolerantly: a body that
    // isn't JSON, or a response shape without .json(), must not mask the
    // original HTTP status in a secondary error. `.catch()` alone would not
    // save us from a response object whose .json is missing entirely (that
    // throws synchronously rather than rejecting), so wrap the call itself.
    const body = await (async () => {
      try {
        return (await response.json()) as { error?: unknown };
      } catch {
        return null;
      }
    })();
    const detail =
      body && typeof body.error === "string" ? `: ${body.error}` : "";
    throw new CredentialsFetchError(
      `Failed to fetch credentials: ${response.status} ${response.statusText}${detail}`,
      response.status,
    );
  }

  const data = (await response.json()) as {
    type?: unknown;
    credentials?: unknown;
  };
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
  description:
    "Email integration (Gmail and Microsoft 365) with per-agent permissions.",

  register(api: PluginApi) {
    // Capture agentConfigs at register() time. OpenClaw calls register() with a
    // fully-populated api.pluginConfig; the reference may be reset after the call
    // returns, so factories must not read api.pluginConfig?.agents dynamically —
    // they would see an empty map and return null, causing tools to vanish from
    // the tool list for every session. apiBaseUrl and gatewayToken are only needed
    // inside execute(), where the config reference is still live, so those can be
    // read dynamically without issue.
    const agentConfigs = api.pluginConfig?.agents ?? {};

    // When OC calls the factory with no session context (probe call during hot-reload
    // or tool-discovery mode), return a minimal stub so OC keeps the tool registered.
    // A real session call (with agentId) will supersede this.
    function probeStub(name: string): AgentTool {
      return {
        name,
        label: name,
        description: "",
        parameters: { type: "object", properties: {} },
        execute: async () => {
          // A real session call (with agentId) supersedes this stub, so an
          // executed stub means the tool ran without session context. Emit a
          // non-empty message: the audit route only counts non-empty
          // details.error as a failure once OpenClaw strips isError (#404),
          // so an empty string here would be logged outcome=success on staging.
          const text = `Error: ${name} is not available without an active session.`;
          return {
            content: [{ type: "text", text }],
            isError: true as const,
            details: { error: text },
          };
        },
      };
    }

    // EmailAdapter cache per agent. Built lazily on first tool call:
    // fetch credentials from Pinchy → instantiate the appropriate adapter
    // based on credentials.type. TTL keeps the cache fresh enough that
    // token rotation propagates within CREDENTIALS_TTL_MS without anyone
    // restarting OpenClaw — and on a 401 from the provider (which happens
    // immediately after the access token expires, since the Pinchy-side
    // OAuth refresh races the call) we invalidate eagerly and refetch once
    // before surfacing the error.
    const CREDENTIALS_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const cache = new Map<
      string,
      { adapter: EmailAdapter; expiresAt: number }
    >();

    function invalidate(agentId: string, connectionId: string) {
      cache.delete(`${agentId}:${connectionId}`);
    }

    async function getOrCreateClient(
      agentId: string,
      config: AgentEmailConfig,
    ): Promise<EmailAdapter> {
      const cacheKey = `${agentId}:${config.connectionId}`;
      const hit = cache.get(cacheKey);
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
      cache.set(cacheKey, {
        adapter,
        expiresAt: Date.now() + CREDENTIALS_TTL_MS,
      });
      return adapter;
    }

    /**
     * Report a connection as auth-failed and rethrow the original error
     * unchanged. Shared by every place in withAuthRetry that decides an
     * error is terminal (not worth retrying) so the "flag + rethrow" shape
     * can't drift between call sites.
     */
    async function reportAndRethrow(
      connectionId: string,
      error: unknown,
    ): Promise<never> {
      const reason = error instanceof Error ? error.message : String(error);
      // Read apiBaseUrl/gatewayToken dynamically (same as getOrCreateClient):
      // they live on api.pluginConfig, not in this function's scope.
      const apiBaseUrl = api.pluginConfig?.apiBaseUrl ?? "";
      const gatewayToken = api.pluginConfig?.gatewayToken ?? "";
      await reportAuthFailure(apiBaseUrl, connectionId, gatewayToken, reason);
      throw error;
    }

    /**
     * Run an email adapter call with one transparent retry on auth failure.
     * The provider returns a 401 (or "Invalid Credentials") when the access
     * token is stale. Pinchy's credentials API auto-refreshes OAuth tokens
     * server-side, so on a 401 we invalidate the local cache, refetch
     * (which triggers the refresh), and retry once.
     *
     * Credentials-fetch failures are handled separately from provider-call
     * failures: getOrCreateClient can throw a CredentialsFetchError with
     * status 503 when the credentials route detects OAuth settings are
     * missing entirely (OAuthSettingsMissingError) and there is no token to
     * even attempt a call with. That's gated strictly on status 503 — the
     * credentials route emits 503 exclusively for the settings-missing case,
     * so treating it as an auth failure is safe. Any OTHER status (a
     * transient 5xx, a network error, etc.) must NOT flip the connection to
     * auth_failed — those are retried/surfaced like before, without touching
     * connection health.
     */
    async function withAuthRetry<T>(
      agentId: string,
      config: AgentEmailConfig,
      fn: (adapter: EmailAdapter) => Promise<T>,
    ): Promise<T> {
      let adapter: EmailAdapter;
      try {
        adapter = await getOrCreateClient(agentId, config);
      } catch (err) {
        if (err instanceof CredentialsFetchError && err.status === 503) {
          return reportAndRethrow(config.connectionId, err);
        }
        throw err;
      }
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
        invalidate(agentId, config.connectionId);
        let fresh: EmailAdapter;
        try {
          fresh = await getOrCreateClient(agentId, config);
        } catch (refetchErr) {
          if (
            refetchErr instanceof CredentialsFetchError &&
            refetchErr.status === 503
          ) {
            return reportAndRethrow(config.connectionId, refetchErr);
          }
          throw refetchErr;
        }
        try {
          return await fn(fresh);
        } catch (retryErr) {
          return reportAndRethrow(config.connectionId, retryErr);
        }
      }
    }

    // 1. email_list
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx?.agentId;
        if (!agentId) return probeStub("email_list");
        const config = getAgentConfig(agentConfigs, agentId);
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
                  folder: params.folder as Folder | undefined,
                  limit: clampListLimit(params.limit),
                  unreadOnly: params.unreadOnly as boolean | undefined,
                }),
              );

              const handleized = handleizeSummaries(agentId, result);

              return {
                content: [
                  { type: "text", text: JSON.stringify(handleized, null, 2) },
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
        const agentId = ctx?.agentId;
        if (!agentId) return probeStub("email_read");
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

              const resolved = resolveEmailReference(
                agentId,
                params.id as string,
              );
              if (!resolved.ok) return resolved.result;

              const result = await withAuthRetry(agentId, config, (adapter) =>
                adapter.read(resolved.realId),
              );

              const msgHandle = putHandle(agentId, result.id);
              const handleizedAttachments = (result.attachments ?? []).map(
                (a) => ({
                  ...a,
                  id: putAttachmentHandle(agentId, a.id),
                }),
              );
              const handleizedResult = {
                ...result,
                id: msgHandle,
                attachments: handleizedAttachments,
              };

              const content: ContentBlock[] = [
                {
                  type: "text",
                  text: JSON.stringify(handleizedResult, null, 2),
                },
              ];

              if (handleizedAttachments.length > 0) {
                const list = handleizedAttachments
                  .map(
                    (a) =>
                      `- id: ${a.id}, filename: ${a.filename}, mimeType: ${a.mimeType}, size: ${humanReadableSize(a.size)}`,
                  )
                  .join("\n");
                content.push({
                  type: "text",
                  text:
                    `This email has ${handleizedAttachments.length} downloadable attachment(s):\n${list}\n\n` +
                    `Use email_get_attachment with messageId "${msgHandle}" and one of the attachment ids above to save it into the workspace.`,
                });
              }

              return { content };
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
        const agentId = ctx?.agentId;
        if (!agentId) return probeStub("email_search");
        const config = getAgentConfig(agentConfigs, agentId);
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
              text: {
                type: "string",
                description:
                  "Free-text search across sender, subject, and body. Use this for content matches — e.g. an invoice number, an order ID, or a phrase mentioned in the message body. For a subject-only match use `subject` instead.",
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

              // email_search used to take a raw Gmail-style `query` string.
              // It was replaced by the structured DSL fields below, but the
              // JSON schema doesn't declare additionalProperties:false and
              // nothing else in the handler catches a caller still passing
              // `query` — the value would silently be dropped and the
              // adapter would throw a generic "search requires at least one
              // filter field" that never mentions `query`. Guard for it here
              // so the model gets an error it can act on. If `query` and
              // valid DSL fields are both present, treat it as ambiguous
              // intent and reject rather than guess.
              if (typeof params.query === "string" && params.query.length > 0) {
                return errorResult(
                  new Error(
                    "The `query` parameter was removed. email_search now uses structured " +
                      "fields instead of a raw query string: from, to, subject, unread, " +
                      "sinceDays, folder, limit. Re-issue the call using those fields.",
                  ),
                );
              }

              const result = await withAuthRetry(agentId, config, (adapter) =>
                adapter.search({
                  from: params.from as string | undefined,
                  to: params.to as string | undefined,
                  subject: params.subject as string | undefined,
                  text: params.text as string | undefined,
                  unread: params.unread as boolean | undefined,
                  sinceDays: params.sinceDays as number | undefined,
                  folder: params.folder as
                    "INBOX" | "SENT" | "DRAFTS" | "TRASH" | "SPAM" | undefined,
                  limit: clampListLimit(params.limit),
                }),
              );

              const handleized = handleizeSummaries(agentId, result);

              return {
                content: [
                  { type: "text", text: JSON.stringify(handleized, null, 2) },
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
        const agentId = ctx?.agentId;
        if (!agentId) return probeStub("email_draft");
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

              let replyTo: string | undefined = params.replyTo as
                string | undefined;
              if (replyTo != null) {
                const resolved = resolveEmailReference(agentId, replyTo);
                if (!resolved.ok) return resolved.result;
                replyTo = resolved.realId;
              }

              const result = await withAuthRetry(agentId, config, (adapter) =>
                adapter.draft({
                  to: params.to as string,
                  subject: params.subject as string,
                  body: params.body as string,
                  replyTo,
                }),
              );

              // Never hand the raw provider id back to the model — mint a
              // handle just like email_list/email_read do, so the invariant
              // "model-facing id output is always a handle" holds everywhere.
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        ...result,
                        draftId: putHandle(agentId, result.draftId),
                      },
                      null,
                      2,
                    ),
                  },
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
        const agentId = ctx?.agentId;
        if (!agentId) return probeStub("email_send");
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

              let replyTo: string | undefined = params.replyTo as
                string | undefined;
              if (replyTo != null) {
                const resolved = resolveEmailReference(agentId, replyTo);
                if (!resolved.ok) return resolved.result;
                replyTo = resolved.realId;
              }

              const result = await withAuthRetry(agentId, config, (adapter) =>
                adapter.send({
                  to: params.to as string,
                  subject: params.subject as string,
                  body: params.body as string,
                  replyTo,
                }),
              );

              // Never hand the raw provider id back to the model — mint a
              // handle so a later email_read of the just-sent message copies a
              // short reference, not a corruptible ~150-char Graph id. A null
              // messageId is a "no id available" signal, not an id: leave it.
              const messageId =
                result.messageId == null
                  ? result.messageId
                  : putHandle(agentId, result.messageId);
              const content: ContentBlock[] = [
                {
                  type: "text",
                  text: JSON.stringify({ ...result, messageId }, null, 2),
                },
              ];
              // Some providers (Microsoft Graph, for a direct non-reply send)
              // do not return a real message id for the sent message — the
              // send API answers 202 Accepted with no Location header. Report
              // that honestly instead of letting the bare `messageId: null`
              // JSON read like a failure.
              if (result.messageId == null) {
                content.push({
                  type: "text",
                  text: "The email was sent successfully. This provider did not return a message id for the sent message.",
                });
              }

              return { content };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "email_send" },
    );

    // 6. email_get_attachment
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx?.agentId;
        if (!agentId) return probeStub("email_get_attachment");
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "email_get_attachment",
          label: "Email Get Attachment",
          description:
            "Download an email attachment and save it into the agent's workspace uploads directory. Use the messageId and attachmentId shown by email_read. Returns the saved filename, size, and mime type — NOT the file content.",
          parameters: {
            type: "object",
            properties: {
              messageId: {
                type: "string",
                description:
                  "The email message ID that contains the attachment",
              },
              attachmentId: {
                type: "string",
                description: "The attachment ID, as shown by email_read",
              },
            },
            required: ["messageId", "attachmentId"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              if (!checkPermission(config.permissions, "email", "read")) {
                return permissionDenied("read");
              }

              const resolvedMessageId = resolveEmailReference(
                agentId,
                params.messageId as string,
              );
              if (!resolvedMessageId.ok) return resolvedMessageId.result;
              const resolvedAttachmentId = resolveEmailReference(
                agentId,
                params.attachmentId as string,
              );
              if (!resolvedAttachmentId.ok) return resolvedAttachmentId.result;

              const messageId = resolvedMessageId.realId;
              const attachmentId = resolvedAttachmentId.realId;

              // No pre-download size precheck is possible here: the
              // EmailAdapter#getAttachment contract returns { filename,
              // mimeType, data } — the provider APIs don't expose a byte
              // size before the body is fetched, unlike odoo_attach_file's
              // local-file stat() precheck. We always postcheck data.length
              // below, which is what actually protects the process (metadata
              // can lie or be absent; the downloaded buffer cannot).
              const attachment = await withAuthRetry(
                agentId,
                config,
                (adapter) => adapter.getAttachment(messageId, attachmentId),
              );

              if (attachment.data.length > MAX_ATTACHMENT_BYTES) {
                const sizeMb = (attachment.data.length / 1024 / 1024).toFixed(
                  1,
                );
                const maxMb = (MAX_ATTACHMENT_BYTES / 1024 / 1024).toFixed(0);
                throw new Error(
                  `Attachment too large: ${sizeMb} MB, max allowed is ${maxMb} MB.`,
                );
              }

              const dir = `${WORKSPACE_ROOT}/${agentId}/uploads`;
              await mkdir(dir, { recursive: true });

              const sanitized = sanitizeAttachmentFilename(
                attachment.filename,
                attachmentId,
                attachment.mimeType,
              );
              const finalFilename = await pickUniqueFilename(dir, sanitized);
              const filePath = `${dir}/${finalFilename}`;

              // Defense-in-depth: confirm the resolved path never escapes the
              // agent's uploads directory, even though sanitizeAttachmentFilename
              // already strips path separators and ".." segments. NOTE: this
              // check alone would NOT catch a literal ".." / "." filename — it
              // relies on sanitizeAttachmentFilename stripping leading dots so
              // those forms fall into the attachment-<id> fallback and never
              // reach here. Keep that leading-dot strip if you refactor the
              // sanitizer.
              if (
                basename(filePath) !== finalFilename ||
                !filePath.startsWith(`${dir}/`)
              ) {
                throw new Error(
                  `Refusing to write attachment outside the uploads directory: ${finalFilename}`,
                );
              }

              // Exclusive create ("wx"): fail rather than overwrite if the name
              // now exists (closes the TOCTOU window after pickUniqueFilename)
              // and refuse to follow a pre-existing symlink at the target — a
              // downloaded attachment must never clobber an existing workspace
              // file or be redirected outside uploads/ via a planted symlink.
              await writeFile(filePath, attachment.data, { flag: "wx" });

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(
                      {
                        filename: finalFilename,
                        size: attachment.data.length,
                        mimeType: attachment.mimeType,
                      },
                      null,
                      2,
                    ),
                  },
                  {
                    type: "text",
                    text:
                      `Saved to the workspace uploads directory as "${finalFilename}" ` +
                      `(${humanReadableSize(attachment.data.length)}). Readable with the pdf tool ` +
                      `(for PDFs); attachable to an Odoo record via odoo_attach_file using this filename.`,
                  },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "email_get_attachment" },
    );
  },
};

export default plugin;
