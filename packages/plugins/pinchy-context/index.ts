import { unlinkSync } from "fs";
import { join } from "path";

interface PluginToolContext {
  agentId?: string;
}

interface AgentContextConfig {
  tools: string[];
  userId: string;
}

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, AgentContextConfig>;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
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
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    details?: unknown;
  }>;
}

function getAgentConfig(
  agents: Record<string, AgentContextConfig>,
  agentId: string
): AgentContextConfig | null {
  return agents[agentId] ?? null;
}

function deleteOnboardingFile(agentId: string): void {
  try {
    const workspacePath = `/root/.openclaw/workspaces/${agentId}`;
    unlinkSync(join(workspacePath, "ONBOARDING.md"));
  } catch {
    // File may not exist, that's fine
  }
}

const plugin = {
  id: "pinchy-context",
  name: "Pinchy Context",
  description:
    "Allows agents to save user and organization context during onboarding.",
  configSchema: {
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "agents" in value &&
        "apiBaseUrl" in value &&
        "gatewayToken" in value
      ) {
        return { ok: true as const, value };
      }
      return {
        ok: false as const,
        errors: ["Missing required keys in config"],
      };
    },
  },

  register(api: PluginApi) {
    const config = api.pluginConfig;
    if (!config) return;

    const { apiBaseUrl, gatewayToken, agents: agentConfigs } = config;

    // save_user_context tool
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;

        const agentConfig = getAgentConfig(agentConfigs, agentId);
        if (!agentConfig || !agentConfig.tools.includes("save_user_context"))
          return null;

        return {
          name: "pinchy_save_user_context",
          label: "Save User Context",
          description:
            "Save a structured summary of the user's personal context (name, role, preferences, work style). Use this after learning enough about the user through conversation.",
          parameters: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description:
                  "Markdown-formatted summary of the user's context",
              },
            },
            required: ["content"],
          },
          async execute(
            _toolCallId: string,
            params: Record<string, unknown>
          ) {
            try {
              const content = params.content as string;
              const res = await fetch(
                `${apiBaseUrl}/api/internal/users/${agentConfig.userId}/context`,
                {
                  method: "PUT",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${gatewayToken}`,
                  },
                  body: JSON.stringify({ content }),
                }
              );

              if (!res.ok) {
                const data = await res.json();
                return {
                  content: [
                    {
                      type: "text",
                      text: `Failed to save: ${data.error || "Unknown error"}`,
                    },
                  ],
                };
              }

              const data = await res.json();

              if (data.onboardingComplete) {
                deleteOnboardingFile(agentId);
              }

              return {
                content: [
                  {
                    type: "text",
                    text: data.onboardingComplete
                      ? "User context saved. Onboarding complete."
                      : "User context saved. Now ask about the organization.",
                  },
                ],
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return { content: [{ type: "text", text: message }] };
            }
          },
        };
      },
      { name: "pinchy_save_user_context" }
    );

    // save_org_context tool
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;

        const agentConfig = getAgentConfig(agentConfigs, agentId);
        if (!agentConfig || !agentConfig.tools.includes("save_org_context"))
          return null;

        return {
          name: "pinchy_save_org_context",
          label: "Save Organization Context",
          description:
            "Save a structured summary of the organization's context (company name, team structure, conventions, domain knowledge). Use this after learning enough about the organization.",
          parameters: {
            type: "object",
            properties: {
              content: {
                type: "string",
                description:
                  "Markdown-formatted summary of the organization context",
              },
            },
            required: ["content"],
          },
          async execute(
            _toolCallId: string,
            params: Record<string, unknown>
          ) {
            try {
              const content = params.content as string;
              const res = await fetch(
                `${apiBaseUrl}/api/internal/settings/context`,
                {
                  method: "PUT",
                  headers: {
                    "Content-Type": "application/json",
                    Authorization: `Bearer ${gatewayToken}`,
                  },
                  body: JSON.stringify({ content }),
                }
              );

              if (!res.ok) {
                const data = await res.json();
                return {
                  content: [
                    {
                      type: "text",
                      text: `Failed to save: ${data.error || "Unknown error"}`,
                    },
                  ],
                };
              }

              const data = await res.json();

              if (data.onboardingComplete) {
                deleteOnboardingFile(agentId);
              }

              return {
                content: [
                  {
                    type: "text",
                    text: "Organization context saved. Onboarding complete.",
                  },
                ],
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return { content: [{ type: "text", text: message }] };
            }
          },
        };
      },
      { name: "pinchy_save_org_context" }
    );
  },
};

export default plugin;
