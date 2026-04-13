import {
  checkPermission,
  getPermittedEntities,
  type Permissions,
} from "./permissions";

interface PluginToolContext {
  agentId?: string;
}

interface ContentBlock {
  type: string;
  text: string;
}

interface PluginApi {
  pluginConfig?: {
    agents?: Record<string, AgentPipedriveConfig>;
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
  ) => Promise<{ content: ContentBlock[]; isError?: boolean }>;
}

interface AgentPipedriveConfig {
  connection: {
    name: string;
    apiToken: string;
    companyDomain: string;
  };
  permissions: Permissions;
  entityNames?: Record<string, string>;
}

const PIPEDRIVE_BASE_URL = "https://api.pipedrive.com";

const V2_ENTITIES = new Set([
  "deals",
  "persons",
  "organizations",
  "activities",
  "products",
  "pipelines",
  "stages",
]);

const FIELDS_ENDPOINTS: Record<string, string> = {
  deals: "/v1/dealFields",
  persons: "/v1/personFields",
  organizations: "/v1/organizationFields",
  leads: "/v1/leadFields",
  activities: "/v1/activityFields",
  products: "/v1/productFields",
  notes: "/v1/noteFields",
};

function entityBasePath(entity: string): string {
  const version = V2_ENTITIES.has(entity) ? "v2" : "v1";
  return `/${version}/${entity}`;
}

async function apiCall(
  apiToken: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ success: boolean; data: unknown; additional_data?: unknown; error?: string }> {
  const url = `${PIPEDRIVE_BASE_URL}${path}`;
  const response = await fetch(url, {
    method,
    headers: {
      "x-api-token": apiToken,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await response.json();
  if (!json.success) {
    throw new Error(json.error ?? `API error (HTTP ${response.status})`);
  }
  return json;
}

function getAgentConfig(
  agentConfigs: Record<string, AgentPipedriveConfig>,
  agentId: string,
): AgentPipedriveConfig | null {
  return agentConfigs[agentId] ?? null;
}

function permissionDenied(
  operation: string,
  entity: string,
): { content: ContentBlock[]; isError: true } {
  return {
    isError: true,
    content: [
      {
        type: "text",
        text: `Permission denied: ${operation} on ${entity} is not allowed for this agent.`,
      },
    ],
  };
}

function errorResult(error: unknown): { content: ContentBlock[]; isError: true } {
  const message = error instanceof Error ? error.message : "Unknown error";
  return { isError: true, content: [{ type: "text", text: `Error: ${message}` }] };
}

// Map Pipedrive search result type names to entity names used in permissions
const SEARCH_TYPE_TO_ENTITY: Record<string, string> = {
  deal: "deals",
  person: "persons",
  organization: "organizations",
  product: "products",
  lead: "leads",
  file: "files",
};

const plugin = {
  id: "pinchy-pipedrive",
  name: "Pinchy Pipedrive",
  description: "Pipedrive CRM integration with entity-level permissions.",

  register(api: PluginApi) {
    const agentConfigs = api.pluginConfig?.agents ?? {};

    // 1. pipedrive_schema
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_schema",
          label: "Pipedrive Schema",
          description:
            "Discover available Pipedrive entities and their fields. Call without parameters to list all available entities with their display names. Call with an entity name to see its fields.",
          parameters: {
            type: "object",
            properties: {
              entity: {
                type: "string",
                description:
                  "Entity name to get fields for (e.g. 'deals', 'persons'). Omit to list all available entities.",
              },
            },
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const entity = params.entity as string | undefined;
              const names = config.entityNames ?? {};

              if (!entity) {
                const permittedEntities = getPermittedEntities(config.permissions, "read");
                const entities = permittedEntities.map((e) => ({
                  entity: e,
                  name: names[e] ?? e,
                }));
                return { content: [{ type: "text", text: JSON.stringify(entities) }] };
              }

              if (!config.permissions[entity]) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `Entity "${entity}" is not available for this agent.`,
                    },
                  ],
                };
              }

              const fieldsEndpoint = FIELDS_ENDPOINTS[entity];
              if (!fieldsEndpoint) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `Entity "${entity}" has no fields endpoint available.`,
                    },
                  ],
                };
              }

              const result = await apiCall(config.connection.apiToken, "GET", fieldsEndpoint);
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      name: names[entity] ?? entity,
                      fields: result.data,
                    }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_schema" },
    );

    // 2. pipedrive_read
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_read",
          label: "Pipedrive Read",
          description:
            "Read records from Pipedrive. Returns matching records with optional field selection and pagination.",
          parameters: {
            type: "object",
            properties: {
              entity: {
                type: "string",
                description: "Entity name, e.g. 'deals', 'persons', 'organizations'",
              },
              filters: {
                type: "object",
                description: "Optional filter parameters as key-value pairs for query string",
              },
              fields: {
                type: "array",
                items: { type: "string" },
                description: "Fields to return. Omit for all fields.",
              },
              limit: { type: "number", description: "Max records (default: 50)" },
              cursor: {
                type: "string",
                description: "Cursor for pagination (from previous response's additional_data.next_cursor)",
              },
            },
            required: ["entity"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const entity = params.entity as string;
              if (!checkPermission(config.permissions, entity, "read")) {
                return permissionDenied("read", entity);
              }

              const basePath = entityBasePath(entity);
              const queryParams = new URLSearchParams();

              const limit = (params.limit as number) ?? 50;
              queryParams.set("limit", String(limit));

              if (params.cursor) {
                queryParams.set("cursor", params.cursor as string);
              }

              if (params.fields) {
                queryParams.set("fields", (params.fields as string[]).join(","));
              }

              if (params.filters) {
                const filters = params.filters as Record<string, string>;
                for (const [key, value] of Object.entries(filters)) {
                  queryParams.set(key, String(value));
                }
              }

              const path = `${basePath}?${queryParams.toString()}`;
              const result = await apiCall(config.connection.apiToken, "GET", path);

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      data: result.data,
                      additional_data: result.additional_data,
                    }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_read" },
    );

    // 3. pipedrive_create
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_create",
          label: "Pipedrive Create",
          description: "Create a new record in Pipedrive. Returns the created record.",
          parameters: {
            type: "object",
            properties: {
              entity: {
                type: "string",
                description: "Entity name, e.g. 'deals', 'persons', 'organizations'",
              },
              data: {
                type: "object",
                description: "Field values for the new record",
              },
            },
            required: ["entity", "data"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const entity = params.entity as string;
              if (!checkPermission(config.permissions, entity, "create")) {
                return permissionDenied("create", entity);
              }

              const basePath = entityBasePath(entity);
              const result = await apiCall(
                config.connection.apiToken,
                "POST",
                basePath,
                params.data,
              );

              return {
                content: [{ type: "text", text: JSON.stringify({ data: result.data }) }],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_create" },
    );

    // 4. pipedrive_update
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_update",
          label: "Pipedrive Update",
          description: "Update an existing record in Pipedrive.",
          parameters: {
            type: "object",
            properties: {
              entity: {
                type: "string",
                description: "Entity name, e.g. 'deals', 'persons'",
              },
              id: { type: "number", description: "ID of the record to update" },
              data: {
                type: "object",
                description: "Field values to update",
              },
            },
            required: ["entity", "id", "data"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const entity = params.entity as string;
              if (!checkPermission(config.permissions, entity, "update")) {
                return permissionDenied("update", entity);
              }

              const basePath = entityBasePath(entity);
              const result = await apiCall(
                config.connection.apiToken,
                "PATCH",
                `${basePath}/${params.id}`,
                params.data,
              );

              return {
                content: [{ type: "text", text: JSON.stringify({ data: result.data }) }],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_update" },
    );

    // 5. pipedrive_delete
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_delete",
          label: "Pipedrive Delete",
          description: "Delete a record from Pipedrive.",
          parameters: {
            type: "object",
            properties: {
              entity: {
                type: "string",
                description: "Entity name, e.g. 'deals', 'persons'",
              },
              id: { type: "number", description: "ID of the record to delete" },
            },
            required: ["entity", "id"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const entity = params.entity as string;
              if (!checkPermission(config.permissions, entity, "delete")) {
                return permissionDenied("delete", entity);
              }

              const basePath = entityBasePath(entity);
              const result = await apiCall(
                config.connection.apiToken,
                "DELETE",
                `${basePath}/${params.id}`,
              );

              return {
                content: [{ type: "text", text: JSON.stringify({ data: result.data }) }],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_delete" },
    );

    // 6. pipedrive_search
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_search",
          label: "Pipedrive Search",
          description:
            "Search across Pipedrive entities. Results are filtered to only include entity types the agent has permission to read.",
          parameters: {
            type: "object",
            properties: {
              term: { type: "string", description: "Search term" },
              entity_types: {
                type: "array",
                items: { type: "string" },
                description:
                  "Entity types to search (e.g. 'deal', 'person', 'organization'). Omit to search all permitted types.",
              },
              limit: { type: "number", description: "Max results (default: 50)" },
            },
            required: ["term"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const queryParams = new URLSearchParams();
              queryParams.set("term", params.term as string);

              if (params.entity_types) {
                queryParams.set(
                  "item_types",
                  (params.entity_types as string[]).join(","),
                );
              }

              if (params.limit) {
                queryParams.set("limit", String(params.limit));
              }

              const path = `/v2/itemSearch?${queryParams.toString()}`;
              const result = await apiCall(config.connection.apiToken, "GET", path);

              // Filter results to only include entity types the agent has read permission for
              const permittedEntities = getPermittedEntities(config.permissions, "read");
              const resultData = result.data as { items?: Array<{ type: string }> };
              const items = resultData?.items ?? [];
              const filteredItems = items.filter((item) => {
                const entityName = SEARCH_TYPE_TO_ENTITY[item.type] ?? item.type;
                return permittedEntities.includes(entityName);
              });

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ items: filteredItems }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_search" },
    );

    // 7. pipedrive_summary
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_summary",
          label: "Pipedrive Summary",
          description:
            "Get deal summaries and pipeline statistics. Types: 'deals_summary' (overall deal stats), 'pipeline_conversion' (conversion rates, requires pipeline_id), 'pipeline_movement' (movement stats, requires pipeline_id).",
          parameters: {
            type: "object",
            properties: {
              type: {
                type: "string",
                description:
                  "Summary type: 'deals_summary', 'pipeline_conversion', or 'pipeline_movement'",
              },
              pipeline_id: {
                type: "number",
                description: "Pipeline ID (required for pipeline_conversion and pipeline_movement)",
              },
              filter_id: {
                type: "number",
                description: "Optional filter ID",
              },
            },
            required: ["type"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              if (!checkPermission(config.permissions, "deals", "read")) {
                return permissionDenied("read", "deals");
              }

              const type = params.type as string;
              const pipelineId = params.pipeline_id as number | undefined;
              const filterId = params.filter_id as number | undefined;

              let path: string;

              if (type === "deals_summary") {
                const queryParams = new URLSearchParams();
                if (filterId) queryParams.set("filter_id", String(filterId));
                const qs = queryParams.toString();
                path = `/v1/deals/summary${qs ? `?${qs}` : ""}`;
              } else if (type === "pipeline_conversion") {
                if (!pipelineId) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: "Error: pipeline_id is required for pipeline_conversion.",
                      },
                    ],
                  };
                }
                path = `/v1/pipelines/${pipelineId}/conversion_statistics`;
              } else if (type === "pipeline_movement") {
                if (!pipelineId) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: "Error: pipeline_id is required for pipeline_movement.",
                      },
                    ],
                  };
                }
                path = `/v1/pipelines/${pipelineId}/movement_statistics`;
              } else {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `Error: Unknown summary type "${type}". Use 'deals_summary', 'pipeline_conversion', or 'pipeline_movement'.`,
                    },
                  ],
                };
              }

              const result = await apiCall(config.connection.apiToken, "GET", path);

              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({ data: result.data }),
                  },
                ],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_summary" },
    );

    // 8. pipedrive_merge
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_merge",
          label: "Pipedrive Merge",
          description:
            "Merge two records of the same entity type. The record specified by 'id' is kept; the record specified by 'merge_with_id' is merged into it and deleted. Supported entities: deals, persons, organizations.",
          parameters: {
            type: "object",
            properties: {
              entity: {
                type: "string",
                description: "Entity type: 'deals', 'persons', or 'organizations'",
              },
              id: {
                type: "number",
                description: "ID of the record to keep",
              },
              merge_with_id: {
                type: "number",
                description: "ID of the record to merge into the kept record (will be deleted)",
              },
            },
            required: ["entity", "id", "merge_with_id"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const entity = params.entity as string;

              // Merge requires both update and delete permissions
              if (
                !checkPermission(config.permissions, entity, "update") ||
                !checkPermission(config.permissions, entity, "delete")
              ) {
                return permissionDenied("merge (requires update + delete)", entity);
              }

              const result = await apiCall(
                config.connection.apiToken,
                "PUT",
                `/v1/${entity}/${params.id}/merge`,
                { merge_with_id: params.merge_with_id },
              );

              return {
                content: [{ type: "text", text: JSON.stringify({ data: result.data }) }],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_merge" },
    );

    // 9. pipedrive_relate
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_relate",
          label: "Pipedrive Relate",
          description:
            "Manage relationships between Pipedrive entities: add/remove products on deals, add/remove participants on deals, add/remove followers on any entity.",
          parameters: {
            type: "object",
            properties: {
              action: {
                type: "string",
                description:
                  "Action: 'add_product', 'remove_product', 'add_participant', 'remove_participant', 'add_follower', 'remove_follower'",
              },
              // Deal-related params
              deal_id: { type: "number", description: "Deal ID (for product/participant actions)" },
              product_id: { type: "number", description: "Product ID (for add_product)" },
              quantity: { type: "number", description: "Quantity (for add_product)" },
              price: { type: "number", description: "Price per item (for add_product)" },
              attachment_id: {
                type: "number",
                description: "Product attachment ID (for remove_product)",
              },
              person_id: { type: "number", description: "Person ID (for add_participant)" },
              participant_id: {
                type: "number",
                description: "Participant ID (for remove_participant)",
              },
              // Follower params
              entity: {
                type: "string",
                description: "Entity type (for follower actions)",
              },
              id: { type: "number", description: "Entity ID (for follower actions)" },
              user_id: { type: "number", description: "User ID (for add_follower)" },
              follower_id: { type: "number", description: "Follower ID (for remove_follower)" },
            },
            required: ["action"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const action = params.action as string;
              let method: string;
              let path: string;
              let body: unknown;
              let targetEntity: string;

              switch (action) {
                case "add_product":
                  targetEntity = "deals";
                  method = "POST";
                  path = `/v1/deals/${params.deal_id}/products`;
                  body = {
                    product_id: params.product_id,
                    quantity: params.quantity,
                    item_price: params.price,
                  };
                  break;
                case "remove_product":
                  targetEntity = "deals";
                  method = "DELETE";
                  path = `/v1/deals/${params.deal_id}/products/${params.attachment_id}`;
                  break;
                case "add_participant":
                  targetEntity = "deals";
                  method = "POST";
                  path = `/v1/deals/${params.deal_id}/participants`;
                  body = { person_id: params.person_id };
                  break;
                case "remove_participant":
                  targetEntity = "deals";
                  method = "DELETE";
                  path = `/v1/deals/${params.deal_id}/participants/${params.participant_id}`;
                  break;
                case "add_follower":
                  targetEntity = params.entity as string;
                  method = "POST";
                  path = `/v1/${targetEntity}/${params.id}/followers`;
                  body = { user_id: params.user_id };
                  break;
                case "remove_follower":
                  targetEntity = params.entity as string;
                  method = "DELETE";
                  path = `/v1/${targetEntity}/${params.id}/followers/${params.follower_id}`;
                  break;
                default:
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: `Error: Unknown action "${action}". Use: add_product, remove_product, add_participant, remove_participant, add_follower, remove_follower.`,
                      },
                    ],
                  };
              }

              if (!checkPermission(config.permissions, targetEntity, "update")) {
                return permissionDenied("update", targetEntity);
              }

              const result = await apiCall(
                config.connection.apiToken,
                method,
                path,
                body,
              );

              return {
                content: [{ type: "text", text: JSON.stringify({ data: result.data }) }],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_relate" },
    );

    // 10. pipedrive_convert
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const config = getAgentConfig(agentConfigs, agentId);
        if (!config) return null;

        return {
          name: "pipedrive_convert",
          label: "Pipedrive Convert",
          description:
            "Convert between leads and deals. 'lead_to_deal' requires create on deals + update on leads. 'deal_to_lead' requires create on leads + update on deals.",
          parameters: {
            type: "object",
            properties: {
              direction: {
                type: "string",
                description: "Conversion direction: 'lead_to_deal' or 'deal_to_lead'",
              },
              id: {
                type: "number",
                description: "ID of the source entity to convert",
              },
            },
            required: ["direction", "id"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const direction = params.direction as string;
              const id = params.id as number;

              let path: string;
              let sourceEntity: string;
              let targetEntity: string;

              if (direction === "lead_to_deal") {
                sourceEntity = "leads";
                targetEntity = "deals";
                path = `/v2/leads/${id}/convert/deal`;
              } else if (direction === "deal_to_lead") {
                sourceEntity = "deals";
                targetEntity = "leads";
                path = `/v2/deals/${id}/convert/lead`;
              } else {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `Error: Unknown direction "${direction}". Use 'lead_to_deal' or 'deal_to_lead'.`,
                    },
                  ],
                };
              }

              // Requires create on target + update on source
              if (!checkPermission(config.permissions, targetEntity, "create")) {
                return permissionDenied("create", targetEntity);
              }
              if (!checkPermission(config.permissions, sourceEntity, "update")) {
                return permissionDenied("update", sourceEntity);
              }

              const result = await apiCall(config.connection.apiToken, "POST", path);

              return {
                content: [{ type: "text", text: JSON.stringify({ data: result.data }) }],
              };
            } catch (error) {
              return errorResult(error);
            }
          },
        };
      },
      { name: "pipedrive_convert" },
    );
  },
};

export default plugin;
