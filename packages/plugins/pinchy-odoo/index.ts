import { OdooClient } from "odoo-node";
import { checkPermission, getPermittedModels, type Permissions } from "./permissions";

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
  ) => Promise<{ content: ContentBlock[]; isError?: boolean; details?: unknown }>;
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, AgentOdooConfig>;
}

interface AgentOdooConfig {
  connectionId: string;
  permissions: Permissions;
  modelNames?: Record<string, string>;
}

interface OdooCredentials {
  url: string;
  db: string;
  uid: number;
  apiKey: string;
}

function getAgentConfig(
  agentConfigs: Record<string, AgentOdooConfig>,
  agentId: string,
): AgentOdooConfig | null {
  return agentConfigs[agentId] ?? null;
}

/**
 * Defense-in-depth: fail fast with a clear error if the credentials API
 * returns the wrong shape (e.g. a SecretRef object instead of strings —
 * the bug that caused Odoo's Python server to crash with
 * `unhashable type: 'dict'`, see issue #209). Without this assertion a
 * malformed payload would propagate all the way to Odoo before erroring.
 */
function assertCredentialsShape(creds: unknown): asserts creds is OdooCredentials {
  if (!creds || typeof creds !== "object") {
    throw new Error(`pinchy-odoo: credentials must be an object, got ${typeof creds}`);
  }
  const obj = creds as Record<string, unknown>;
  // Detect the SecretRef-shaped payload (#209) up front so the error
  // message points at the actual root cause instead of a "field missing"
  // symptom that's harder to debug.
  const looksLikeSecretRef =
    typeof obj.source === "string" && typeof obj.provider === "string" && typeof obj.id === "string";
  const expected: Array<[keyof OdooCredentials, "string" | "number"]> = [
    ["url", "string"],
    ["db", "string"],
    ["uid", "number"],
    ["apiKey", "string"],
  ];
  for (const [name, type] of expected) {
    const actual = typeof obj[name];
    if (actual !== type) {
      const hint = looksLikeSecretRef
        ? " (the credentials API returned an unresolved SecretRef — see #209)"
        : actual === "object"
          ? " (looks like an unresolved SecretRef — see #209)"
          : "";
      throw new Error(
        `pinchy-odoo: credentials.${name} must be a ${type}, got ${actual}${hint}`,
      );
    }
  }
}

/**
 * Fetch decrypted Odoo credentials from Pinchy's internal credentials API.
 *
 * The plugin only ever sees the connectionId and a gateway token — the
 * actual apiKey lives in Pinchy's encrypted database and is delivered
 * over a single authenticated HTTP request per cache miss. This keeps
 * `openclaw.json` free of long-lived per-tenant secrets and lets Pinchy
 * own rotation, audit, and per-agent authorization centrally.
 *
 * See: packages/web/src/app/api/internal/integrations/[connectionId]/credentials/route.ts
 */
async function fetchCredentials(
  apiBaseUrl: string,
  gatewayToken: string,
  connectionId: string,
): Promise<OdooCredentials> {
  const response = await fetch(
    `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials`,
    { headers: { Authorization: `Bearer ${gatewayToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Odoo credentials for connection ${connectionId}: ` +
        `HTTP ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as { credentials?: unknown };
  assertCredentialsShape(data.credentials);
  return data.credentials;
}

function createClient(creds: OdooCredentials): OdooClient {
  return new OdooClient({
    url: creds.url,
    db: creds.db,
    uid: creds.uid,
    apiKey: creds.apiKey,
  });
}

function permissionDenied(operation: string, model: string): { content: ContentBlock[]; isError: true } {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Permission denied: ${operation} on ${model} is not allowed for this agent.`,
      },
    ],
  };
}

function isOdooAccessError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("accesserror") ||
    msg.includes("access denied") ||
    msg.includes("not allowed") ||
    msg.includes("permission denied")
  );
}

function errorResult(error: unknown, context?: { operation?: string; model?: string }): { content: ContentBlock[]; isError: true } {
  if (isOdooAccessError(error) && context?.model) {
    const op = context.operation ?? "access";
    return {
      isError: true,
      content: [
        {
          type: "text",
          text: `Odoo denied permission to ${op} on ${context.model}. The Odoo user's permissions may have changed since the last sync. An admin can re-sync the connection in Settings > Integrations to update available permissions.`,
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

const plugin = {
  id: "pinchy-odoo",
  name: "Pinchy Odoo",
  description: "Odoo ERP integration with model-level permissions.",

  register(api: PluginApi) {
    const pluginConfig = api.pluginConfig;
    const agentConfigs = pluginConfig?.agents ?? {};
    const apiBaseUrl = pluginConfig?.apiBaseUrl ?? "";
    const gatewayToken = pluginConfig?.gatewayToken ?? "";

    // Client cache per agent. Built lazily on first tool call: fetch
    // credentials from Pinchy → instantiate OdooClient. TTL keeps the
    // cache fresh enough that credential rotation propagates within
    // CREDENTIALS_TTL_MS without anyone restarting OpenClaw — and on a
    // 401 from Odoo (which is what happens immediately after a rotation
    // or revocation) we invalidate eagerly and refetch once before
    // surfacing the error to the user.
    const CREDENTIALS_TTL_MS = 5 * 60 * 1000; // 5 minutes
    const cache = new Map<string, { client: OdooClient; expiresAt: number }>();

    function invalidate(agentId: string) {
      cache.delete(agentId);
    }

    async function getOrCreateClient(
      agentId: string,
      config: AgentOdooConfig,
    ): Promise<OdooClient> {
      const hit = cache.get(agentId);
      if (hit && hit.expiresAt > Date.now()) return hit.client;
      const creds = await fetchCredentials(apiBaseUrl, gatewayToken, config.connectionId);
      const client = createClient(creds);
      cache.set(agentId, { client, expiresAt: Date.now() + CREDENTIALS_TTL_MS });
      return client;
    }

    /**
     * Run an Odoo call with one transparent retry on auth failure.
     * Odoo throws an `AccessDenied` / 401-shaped error when the apiKey is
     * stale (rotated, revoked, expired). We invalidate the cache and
     * fetch fresh credentials once — if it still fails, surface to the
     * user.
     */
    async function withAuthRetry<T>(
      agentId: string,
      config: AgentOdooConfig,
      fn: (client: OdooClient) => Promise<T>,
    ): Promise<T> {
      const client = await getOrCreateClient(agentId, config);
      try {
        return await fn(client);
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : "";
        const isAuthError =
          msg.includes("access denied") ||
          msg.includes("invalid api key") ||
          msg.includes("401") ||
          msg.includes("authenticat");
        if (!isAuthError) throw err;
        invalidate(agentId);
        const fresh = await getOrCreateClient(agentId, config);
        return fn(fresh);
      }
    }

    // 1. odoo_schema
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_schema",
          label: "Odoo Schema",
          description:
            "Discover available Odoo models and their fields. Call without parameters to list all available models with their human-readable names. Call with a model name to see its fields, types, and relations.",
          parameters: {
            type: "object",
            properties: {
              model: {
                type: "string",
                description: "Model name to get fields for. Omit to list all available models.",
              },
            },
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string | undefined;
              const names = config.modelNames ?? {};

              if (!model) {
                // List all permitted models with human-readable names
                const permittedModels = getPermittedModels(config.permissions, "read");
                const models = permittedModels.map((m) => ({
                  model: m,
                  name: names[m] ?? m,
                }));
                return { content: [{ type: "text", text: JSON.stringify(models) }] };
              }

              // Check if model is in permissions
              if (!config.permissions[model]) {
                return {
                  isError: true,
                  content: [
                    { type: "text", text: `Model "${model}" is not available for this agent.` },
                  ],
                };
              }

              // Fetch fields live from Odoo (lightweight call — the agent
              // caches the result in its conversation context naturally)
              const fields = await withAuthRetry(agentId, config, (client) =>
                client.fields(model),
              );

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ name: names[model] ?? model, fields }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "odoo_schema" },
    );

    // 2. odoo_read
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_read",
          label: "Odoo Read",
          description:
            "Query records from Odoo. Returns matching records with field selection and pagination. Always returns { records, total, limit, offset } so you know if there's more data.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name, e.g. 'sale.order'" },
              filters: {
                type: "array",
                items: {
                  type: "array",
                  description: "A [field, operator, value] tuple, e.g. ['state', '=', 'sale']",
                },
                description:
                  "Odoo domain filter. Array of [field, operator, value] tuples. Operators: =, !=, >, >=, <, <=, in, not in, like, ilike. Use [] for no filter.",
              },
              fields: {
                type: "array",
                items: { type: "string" },
                description: "Fields to return. Omit for default fields.",
              },
              limit: { type: "number", description: "Max records (default: 100)" },
              offset: { type: "number", description: "Skip N records for pagination" },
              order: { type: "string", description: "Sort order, e.g. 'date_order desc'" },
            },
            required: ["model", "filters"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "read")) {
                return permissionDenied("read", model);
              }

              const result = await withAuthRetry(agentId, config, (client) =>
                client.searchRead(model, params.filters as unknown[], {
                  fields: params.fields as string[] | undefined,
                  limit: params.limit as number | undefined,
                  offset: params.offset as number | undefined,
                  order: params.order as string | undefined,
                }),
              );

              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
              return errorResult(error, { operation: "read", model: params.model as string });
            }
          },
        };
      },
      { name: "odoo_read" },
    );

    // 3. odoo_count
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_count",
          label: "Odoo Count",
          description:
            "Count matching records without transferring data. Much faster than reading all records.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              filters: {
                type: "array",
                items: { type: "array", description: "A [field, operator, value] tuple" },
                description: "Odoo domain filter. Use [] for no filter.",
              },
            },
            required: ["model", "filters"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "read")) {
                return permissionDenied("read", model);
              }

              const count = await withAuthRetry(agentId, config, (client) =>
                client.searchCount(model, params.filters as unknown[]),
              );

              return { content: [{ type: "text", text: JSON.stringify({ count }) }] };
            } catch (error) {
              return errorResult(error, { operation: "count", model: params.model as string });
            }
          },
        };
      },
      { name: "odoo_count" },
    );

    // 4. odoo_aggregate
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_aggregate",
          label: "Odoo Aggregate",
          description:
            "Server-side aggregation — sums, averages, counts, grouped by fields. Use this instead of reading records and calculating yourself. Fields support aggregation: 'amount_total:sum', 'amount_total:avg', 'partner_id:count_distinct'. Groupby supports date granularity: 'date_order:month', 'date_order:week', 'date_order:year'.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              filters: {
                type: "array",
                items: { type: "array", description: "A [field, operator, value] tuple" },
                description: "Odoo domain filter. Use [] for no filter.",
              },
              fields: {
                type: "array",
                items: { type: "string" },
                description:
                  "Fields with optional aggregation, e.g. ['partner_id', 'amount_total:sum']",
              },
              groupby: {
                type: "array",
                items: { type: "string" },
                description: "Fields to group by, e.g. ['partner_id'] or ['date_order:month']",
              },
              limit: { type: "number", description: "Max groups to return" },
              offset: { type: "number", description: "Skip N groups for pagination" },
              orderby: { type: "string", description: "Sort order for groups" },
            },
            required: ["model", "filters", "fields", "groupby"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "read")) {
                return permissionDenied("read", model);
              }

              const result = await withAuthRetry(agentId, config, (client) =>
                client.readGroup(
                  model,
                  params.filters as unknown[],
                  params.fields as string[],
                  params.groupby as string[],
                  {
                    limit: params.limit as number | undefined,
                    offset: params.offset as number | undefined,
                    orderby: params.orderby as string | undefined,
                  },
                ),
              );

              return { content: [{ type: "text", text: JSON.stringify(result) }] };
            } catch (error) {
              return errorResult(error, { operation: "aggregate", model: params.model as string });
            }
          },
        };
      },
      { name: "odoo_aggregate" },
    );

    // 5. odoo_create
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_create",
          label: "Odoo Create",
          description: "Create a new record in Odoo. Returns the ID of the created record.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              values: { type: "object", description: "Field values for the new record" },
            },
            required: ["model", "values"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "create")) {
                return permissionDenied("create", model);
              }

              const id = await withAuthRetry(agentId, config, (client) =>
                client.create(model, params.values as Record<string, unknown>),
              );

              return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
            } catch (error) {
              return errorResult(error, { operation: "create", model: params.model as string });
            }
          },
        };
      },
      { name: "odoo_create" },
    );

    // 6. odoo_write
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_write",
          label: "Odoo Write",
          description: "Update an existing record in Odoo.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              ids: {
                type: "array",
                items: { type: "number" },
                description: "IDs of records to update",
              },
              values: { type: "object", description: "Field values to update" },
            },
            required: ["model", "ids", "values"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "write")) {
                return permissionDenied("write", model);
              }

              const success = await withAuthRetry(agentId, config, (client) =>
                client.write(
                  model,
                  params.ids as number[],
                  params.values as Record<string, unknown>,
                ),
              );

              return { content: [{ type: "text", text: JSON.stringify({ success }) }] };
            } catch (error) {
              return errorResult(error, { operation: "write", model: params.model as string });
            }
          },
        };
      },
      { name: "odoo_write" },
    );

    // 7. odoo_delete
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "odoo_delete",
          label: "Odoo Delete",
          description: "Delete records from Odoo.",
          parameters: {
            type: "object",
            properties: {
              model: { type: "string", description: "Odoo model name" },
              ids: {
                type: "array",
                items: { type: "number" },
                description: "IDs of records to delete",
              },
            },
            required: ["model", "ids"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const model = params.model as string;
              if (!checkPermission(config.permissions, model, "delete")) {
                return permissionDenied("delete", model);
              }

              const success = await withAuthRetry(agentId, config, (client) =>
                client.unlink(model, params.ids as number[]),
              );

              return { content: [{ type: "text", text: JSON.stringify({ success }) }] };
            } catch (error) {
              return errorResult(error, { operation: "delete", model: params.model as string });
            }
          },
        };
      },
      { name: "odoo_delete" },
    );
  },
};

export default plugin;
