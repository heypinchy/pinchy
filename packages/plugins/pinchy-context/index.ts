import { unlinkSync } from "fs";
import { join } from "path";

// Bounds every call to Pinchy's own internal API against a hung container /
// network blackhole.
const FETCH_TIMEOUT_MS = 10_000;

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
    isError?: boolean;
    details?: unknown;
  }>;
}

function getAgentConfig(
  agents: Record<string, AgentContextConfig>,
  agentId: string
): AgentContextConfig | null {
  return agents[agentId] ?? null;
}

/**
 * Quote the reason the API gave, not just its headline. A rejected save answers
 * `{ error: "Validation failed", details: { fieldErrors: { content: [...] } } }`
 * — reporting `error` alone tells the model nothing it can act on (it would
 * retry the same over-long content), while the field error says what to change.
 */
function describeApiError(data: unknown): string {
  if (data && typeof data === "object") {
    const { details, error } = data as {
      details?: { fieldErrors?: Record<string, string[] | undefined> };
      error?: unknown;
    };

    const fieldError = Object.values(details?.fieldErrors ?? {})
      .flat()
      .find((message): message is string => typeof message === "string" && message.length > 0);
    if (fieldError) return fieldError;

    if (typeof error === "string" && error.length > 0) return error;
  }

  return "Unknown error";
}

function deleteOnboardingFile(agentId: string): void {
  try {
    const workspacePath = `/root/.openclaw/workspaces/${agentId}`;
    unlinkSync(join(workspacePath, "ONBOARDING.md"));
  } catch {
    // File may not exist, that's fine
  }
}

/**
 * Build an MCP-style error result. Every error result MUST carry
 * `details.error`, not just the `isError` flag: OpenClaw strips `isError`
 * before forwarding the result to `/api/internal/audit/tool-use` (OC bug
 * #404), and the audit endpoint then falls back to `result.details.error` to
 * record `outcome: failure`. Without it, a failed pinchy-context tool call
 * is silently audited as success. Route ALL error results through this
 * helper so that invariant cannot be forgotten at an individual call site.
 */
function toolError(text: string): {
  content: Array<{ type: string; text: string }>;
  isError: true;
  details: { error: string };
} {
  return {
    isError: true,
    content: [{ type: "text", text }],
    details: { error: text },
  };
}

const plugin = {
  id: "pinchy-context",
  name: "Pinchy Context",
  description: "Allows agents to save user and organization context during onboarding.",
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
        if (!agentConfig || !agentConfig.tools.includes("save_user_context")) return null;

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
                description: "Markdown-formatted summary of the user's context",
              },
            },
            required: ["content"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
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
                  signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
                }
              );

              if (!res.ok) {
                const data = await res.json();
                return toolError(`Failed to save: ${describeApiError(data)}`);
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
              const message = error instanceof Error ? error.message : "Unknown error";
              return toolError(message);
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
        if (!agentConfig || !agentConfig.tools.includes("save_org_context")) return null;

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
                description: "Markdown-formatted summary of the organization context",
              },
            },
            required: ["content"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const content = params.content as string;
              const res = await fetch(`${apiBaseUrl}/api/internal/settings/context`, {
                method: "PUT",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${gatewayToken}`,
                },
                body: JSON.stringify({ content }),
                signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
              });

              if (!res.ok) {
                const data = await res.json();
                return toolError(`Failed to save: ${describeApiError(data)}`);
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
              const message = error instanceof Error ? error.message : "Unknown error";
              return toolError(message);
            }
          },
        };
      },
      { name: "pinchy_save_org_context" }
    );
  },
};

export default plugin;
