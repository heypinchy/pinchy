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
  pluginConfig?: {
    agents?: Record<string, AgentOdooConfig>;
  };
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
  ) => Promise<{ content: ContentBlock[]; details?: unknown }>;
}

interface AgentOdooConfig {
  connection: {
    name: string;
    description: string;
    url: string;
    db: string;
    uid: number;
    apiKey: string;
  };
  permissions: Permissions;
  schema?: Record<
    string,
    {
      name: string;
      fields: Array<{
        name: string;
        string: string;
        type: string;
        required: boolean;
        readonly: boolean;
        relation?: string;
        selection?: [string, string][];
      }>;
    }
  >;
}

function getAgentConfig(
  agentConfigs: Record<string, AgentOdooConfig>,
  agentId: string,
): AgentOdooConfig | null {
  return agentConfigs[agentId] ?? null;
}

function createClient(config: AgentOdooConfig): OdooClient {
  return new OdooClient({
    url: config.connection.url,
    db: config.connection.db,
    uid: config.connection.uid,
    apiKey: config.connection.apiKey,
  });
}

function permissionDenied(operation: string, model: string): { content: ContentBlock[] } {
  return {
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
  return msg.includes("accesserror") || msg.includes("access") || msg.includes("permission");
}

function errorResult(error: unknown, context?: { operation?: string; model?: string }): { content: ContentBlock[] } {
  if (isOdooAccessError(error) && context?.model) {
    const op = context.operation ?? "access";
    return {
      content: [
        {
          type: "text",
          text: `Odoo denied permission to ${op} on ${context.model}. The Odoo user's permissions may have changed since the last sync. An admin can re-sync the connection in Settings > Integrations to update available permissions.`,
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : "Unknown error";
  return { content: [{ type: "text", text: `Error: ${message}` }] };
}

const plugin = {
  id: "pinchy-odoo",
  name: "Pinchy Odoo",
  description: "Odoo ERP integration with model-level permissions.",

  register(api: PluginApi) {
    const agentConfigs = api.pluginConfig?.agents ?? {};

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
              const schema = config.schema ?? {};

              if (!model) {
                // List all permitted models
                const permittedModels = Object.keys(config.permissions);
                const models = permittedModels
                  .filter((m) => schema[m])
                  .map((m) => ({ model: m, name: schema[m].name }));
                return { content: [{ type: "text", text: JSON.stringify(models) }] };
              }

              // Check if model is in permissions
              if (!config.permissions[model]) {
                return {
                  content: [
                    { type: "text", text: `Model "${model}" is not available for this agent.` },
                  ],
                };
              }

              const modelSchema = schema[model];
              if (!modelSchema) {
                return {
                  content: [
                    { type: "text", text: `No schema cached for model "${model}".` },
                  ],
                };
              }

              return {
                content: [{ type: "text", text: JSON.stringify(modelSchema) }],
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

              const client = createClient(config);
              const result = await client.searchRead(model, params.filters as unknown[], {
                fields: params.fields as string[] | undefined,
                limit: params.limit as number | undefined,
                offset: params.offset as number | undefined,
                order: params.order as string | undefined,
              });

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

              const client = createClient(config);
              const count = await client.searchCount(model, params.filters as unknown[]);

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

              const client = createClient(config);
              const result = await client.readGroup(
                model,
                params.filters as unknown[],
                params.fields as string[],
                params.groupby as string[],
                {
                  limit: params.limit as number | undefined,
                  offset: params.offset as number | undefined,
                  orderby: params.orderby as string | undefined,
                },
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

              const client = createClient(config);
              const id = await client.create(model, params.values as Record<string, unknown>);

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

              const client = createClient(config);
              const success = await client.write(
                model,
                params.ids as number[],
                params.values as Record<string, unknown>,
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

              const client = createClient(config);
              const success = await client.unlink(model, params.ids as number[]);

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
