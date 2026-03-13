interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
}

interface ToolHookContext {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
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

interface AfterToolCallEvent {
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

interface PluginLogger {
  warn?: (message: string) => void;
  error?: (message: string) => void;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  logger?: PluginLogger;
  on: (
    hookName: "before_tool_call" | "after_tool_call",
    handler: (event: BeforeToolCallEvent | AfterToolCallEvent, ctx: ToolHookContext) => Promise<void>
  ) => void;
}

interface ToolAuditPayload {
  phase: "start" | "end";
  toolName: string;
  params: Record<string, unknown>;
  runId?: string;
  toolCallId?: string;
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  result?: unknown;
  error?: string;
  durationMs?: number;
}

interface RecentToolStart {
  agentId?: string;
  sessionKey?: string;
  sessionId?: string;
  runId?: string;
  at: number;
}

/** Audit failure mode: "closed" blocks tool on failure, "open" warns and continues */
type AuditFailMode = "closed" | "open";

/** Maximum retry attempts for audit logging */
const MAX_RETRIES = 2;

/** Delay between retries in ms */
const RETRY_DELAY_MS = 500;

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

function extractAgentIdFromSessionKey(sessionKey?: string): string | undefined {
  if (!sessionKey) return undefined;
  const match = /^agent:([^:]+):/.exec(sessionKey);
  return match?.[1];
}

function cleanupRecentToolStarts(recentStarts: Map<string, RecentToolStart>): void {
  const now = Date.now();
  const maxAgeMs = 5 * 60 * 1000;

  for (const [key, value] of recentStarts.entries()) {
    if (now - value.at > maxAgeMs) {
      recentStarts.delete(key);
    }
  }
}

function getAuditFailMode(): AuditFailMode {
  const mode = process.env.AUDIT_FAIL_MODE?.toLowerCase();
  if (mode === "open") return "open";
  // Default to "closed" — fail-safe for compliance
  return "closed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Post an audit event with retry logic.
 * Returns true on success, false on failure.
 */
async function postToolAuditEvent(
  cfg: PluginConfig,
  logger: PluginLogger | undefined,
  payload: ToolAuditPayload
): Promise<boolean> {
  const endpoint = `${normalizeBaseUrl(cfg.apiBaseUrl)}/api/internal/audit/tool-use`;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${cfg.gatewayToken}`,
        },
        body: JSON.stringify(payload),
      });

      if (res.ok) return true;

      logger?.warn?.(
        `[pinchy-audit] audit endpoint returned ${res.status} for ${payload.phase} ${payload.toolName} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger?.warn?.(
        `[pinchy-audit] failed to post ${payload.phase} event for ${payload.toolName}: ${message} (attempt ${attempt + 1}/${MAX_RETRIES + 1})`
      );
    }

    if (attempt < MAX_RETRIES) {
      await sleep(RETRY_DELAY_MS);
    }
  }

  return false;
}

const plugin = {
  id: "pinchy-audit",
  name: "Pinchy Audit",
  description: "Source-level tool execution audit logging for all OpenClaw tools.",
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
      api.logger?.warn?.("[pinchy-audit] plugin config is missing apiBaseUrl or gatewayToken");
      return;
    }

    const recentStarts = new Map<string, RecentToolStart>();
    const failMode = getAuditFailMode();

    api.on("before_tool_call", async (event, ctx) => {
      cleanupRecentToolStarts(recentStarts);
      const beforeEvent = event as BeforeToolCallEvent;
      const agentId = ctx.agentId ?? extractAgentIdFromSessionKey(ctx.sessionKey);

      recentStarts.set(beforeEvent.toolName, {
        agentId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
        runId: beforeEvent.runId ?? ctx.runId,
        at: Date.now(),
      });

      const success = await postToolAuditEvent(cfg, api.logger, {
        phase: "start",
        toolName: beforeEvent.toolName,
        params: beforeEvent.params,
        runId: beforeEvent.runId ?? ctx.runId,
        toolCallId: beforeEvent.toolCallId ?? ctx.toolCallId,
        agentId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
      });

      if (!success && failMode === "closed") {
        const msg = `[pinchy-audit] Blocking tool call "${beforeEvent.toolName}" — audit logging failed after ${MAX_RETRIES + 1} attempts (AUDIT_FAIL_MODE=closed)`;
        api.logger?.error?.(msg);
        throw new Error(msg);
      }
    });

    api.on("after_tool_call", async (event, ctx) => {
      cleanupRecentToolStarts(recentStarts);
      const afterEvent = event as AfterToolCallEvent;
      const recent = recentStarts.get(afterEvent.toolName);
      const sessionKey = ctx.sessionKey ?? recent?.sessionKey;
      const sessionId = ctx.sessionId ?? recent?.sessionId;
      const runId = afterEvent.runId ?? ctx.runId ?? recent?.runId;
      const agentId =
        ctx.agentId ??
        extractAgentIdFromSessionKey(sessionKey) ??
        recent?.agentId;

      const success = await postToolAuditEvent(cfg, api.logger, {
        phase: "end",
        toolName: afterEvent.toolName,
        params: afterEvent.params,
        runId,
        toolCallId: afterEvent.toolCallId ?? ctx.toolCallId,
        agentId,
        sessionKey,
        sessionId,
        result: afterEvent.result,
        error: afterEvent.error,
        durationMs: afterEvent.durationMs,
      });

      if (!success && failMode === "closed") {
        api.logger?.error?.(
          `[pinchy-audit] Failed to log "end" event for "${afterEvent.toolName}" after ${MAX_RETRIES + 1} attempts (AUDIT_FAIL_MODE=closed)`
        );
        // Don't throw on "end" — the tool already executed
      }
    });
  },
};

export default plugin;
