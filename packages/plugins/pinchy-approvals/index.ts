import { evaluateGate, type FetchLike, type GateResult } from "./gate";

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
}

interface ToolHookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  senderId?: string;
  runId?: string;
  toolName: string;
  toolCallId?: string;
}

interface BeforeToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
}

interface PluginLogger {
  warn?: (message: string) => void;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  logger?: PluginLogger;
  on: (
    hookName: "before_tool_call",
    handler: (event: BeforeToolCallEvent, ctx: ToolHookContext) => Promise<GateResult>
  ) => void;
}

const plugin = {
  id: "pinchy-approvals",
  name: "Pinchy Approvals",
  description:
    "Human-in-the-loop confirmation gate: pauses tool calls an admin marked as requiring approval until the acting user confirms.",
  configSchema: {
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "apiBaseUrl" in value &&
        "gatewayToken" in value
      ) {
        return { ok: true as const, value };
      }
      return { ok: false as const, errors: ["Missing required keys in config"] };
    },
  },

  register(api: PluginApi) {
    const cfg = api.pluginConfig;
    if (!cfg?.apiBaseUrl || !cfg?.gatewayToken) {
      api.logger?.warn?.(
        "[pinchy-approvals] plugin config is missing apiBaseUrl or gatewayToken"
      );
      return;
    }

    api.on("before_tool_call", async (event, ctx) => {
      return evaluateGate(
        event.toolName,
        event.params,
        { agentId: ctx.agentId, sessionKey: ctx.sessionKey, senderId: ctx.senderId },
        cfg,
        fetch as unknown as FetchLike
      );
    });
  },
};

export default plugin;
