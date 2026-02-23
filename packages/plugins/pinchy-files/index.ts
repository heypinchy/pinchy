import { readFileSync, readdirSync, statSync, realpathSync } from "fs";
import { join } from "path";
import { validateAccess, MAX_FILE_SIZE, type AgentFileConfig } from "./validate";

interface PluginToolContext {
  agentId?: string;
}

interface PluginApi {
  pluginConfig?: {
    agents?: Record<string, AgentFileConfig>;
  };
  registerTool: (
    factory: (ctx: PluginToolContext) => AgentTool | null,
    opts?: { name?: string }
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
    signal?: AbortSignal
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

function getAgentPaths(
  agentConfigs: Record<string, AgentFileConfig>,
  agentId: string
): string[] | null {
  const config = agentConfigs[agentId];
  if (!config) return null;
  return config.allowed_paths;
}

const plugin = {
  id: "pinchy-files",
  name: "Pinchy Files",
  description: "Scoped read-only file access for Pinchy Knowledge Base agents.",
  configSchema: {
    validate: (value: unknown) => {
      if (value && typeof value === "object" && "agents" in value) {
        return { ok: true as const, value };
      }
      return { ok: false as const, errors: ["Missing 'agents' key in config"] };
    },
  },

  register(api: PluginApi) {
    const agentConfigs = api.pluginConfig?.agents ?? {};

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;

        const paths = getAgentPaths(agentConfigs, agentId);
        if (!paths) return null;

        const pathList = paths.join(", ");

        return {
          name: "pinchy_ls",
          label: "List Files",
          description: `List files and directories. You have access to: ${pathList}`,
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: "Directory path to list" },
            },
            required: ["path"],
          },
          async execute(
            _toolCallId: string,
            params: Record<string, unknown>
          ) {
            try {
              const requestedPath = params.path as string;
              const realPath = realpathSync(requestedPath);
              validateAccess({ allowed_paths: paths }, realPath);

              const entries = readdirSync(realPath);
              const results = entries
                .filter((name) => !name.startsWith("."))
                .map((name) => {
                  const fullPath = join(realPath, name);
                  const stats = statSync(fullPath);
                  return {
                    name,
                    type: stats.isDirectory() ? "directory" : "file",
                    size: stats.isFile() ? stats.size : undefined,
                  };
                });

              return {
                content: [
                  { type: "text", text: JSON.stringify(results, null, 2) },
                ],
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return {
                content: [{ type: "text", text: message }],
              };
            }
          },
        };
      },
      { name: "pinchy_ls" }
    );

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;

        const paths = getAgentPaths(agentConfigs, agentId);
        if (!paths) return null;

        const pathList = paths.join(", ");

        return {
          name: "pinchy_read",
          label: "Read File",
          description: `Read a file's content. You have access to: ${pathList}`,
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: "File path to read",
              },
            },
            required: ["path"],
          },
          async execute(
            _toolCallId: string,
            params: Record<string, unknown>
          ) {
            try {
              const requestedPath = params.path as string;
              const realPath = realpathSync(requestedPath);
              validateAccess({ allowed_paths: paths }, realPath);

              const stats = statSync(realPath);
              if (stats.size > MAX_FILE_SIZE) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `File too large (${stats.size} bytes). Maximum: ${MAX_FILE_SIZE} bytes.`,
                    },
                  ],
                };
              }

              const content = readFileSync(realPath, "utf-8");
              return { content: [{ type: "text", text: content }] };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return {
                content: [{ type: "text", text: message }],
              };
            }
          },
        };
      },
      { name: "pinchy_read" }
    );
  },
};

export default plugin;
