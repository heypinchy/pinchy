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

// ── Standalone sanitization (no imports from @pinchy/web) ───────────

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 10;

// SYNC: This sanitization logic is duplicated in packages/web/src/lib/audit-sanitize.ts
// Keep both copies in sync when adding/removing patterns.
const SENSITIVE_KEYS = [
  "password", "secret", "token", "apikey", "api_key",
  "authorization", "credential", "private_key", "privatekey",
  "passphrase", "access_key", "accesskey", "client_secret", "clientsecret",
];

const SECRET_PATTERNS: RegExp[] = [
  /sk-ant-[a-zA-Z0-9\-]{20,}/g,
  /sk-[a-zA-Z0-9]{20,}/g,
  /ghp_[a-zA-Z0-9]{36,}/g,
  /gho_[a-zA-Z0-9]{36,}/g,
  /github_pat_[a-zA-Z0-9_]{20,}/g,
  /xoxb-[a-zA-Z0-9\-]+/g,
  /xoxp-[a-zA-Z0-9\-]+/g,
  /Bearer\s+[a-zA-Z0-9._\-]{20,}/g,
  /[0-9]{8,10}:[a-zA-Z0-9_\-]{35}/g,
  /EAA[a-zA-Z0-9]{20,}/g,
];

const ENV_SECRET_LINE = /^([A-Z_]*(SECRET|KEY|TOKEN|PASSWORD|CREDENTIAL)[A-Z_]*)=(.+)$/gmi;

function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  return SENSITIVE_KEYS.some((pattern) => lower.includes(pattern));
}

function redactPatterns(value: string): string {
  if (value === REDACTED) return value;
  let result = value;
  ENV_SECRET_LINE.lastIndex = 0;
  result = result.replace(ENV_SECRET_LINE, `$1=${REDACTED}`);
  for (const pattern of SECRET_PATTERNS) {
    pattern.lastIndex = 0;
    result = result.replace(pattern, REDACTED);
  }
  return result;
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (value === null || value === undefined) return value;
  if (depth >= MAX_DEPTH) return value;
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, depth + 1));
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(key) && val !== null && val !== undefined) {
        result[key] = REDACTED;
      } else {
        result[key] = sanitizeValue(val, depth + 1);
      }
    }
    return result;
  }
  if (typeof value === "string") return redactPatterns(value);
  return value;
}

function sanitizePayloadFields(payload: ToolAuditPayload): ToolAuditPayload {
  return {
    ...payload,
    params: sanitizeValue(payload.params, 0) as Record<string, unknown>,
    result: sanitizeValue(payload.result, 0),
  };
}

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

async function postToolAuditEvent(
  cfg: PluginConfig,
  logger: PluginLogger | undefined,
  payload: ToolAuditPayload
): Promise<void> {
  const endpoint = `${normalizeBaseUrl(cfg.apiBaseUrl)}/api/internal/audit/tool-use`;

  try {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.gatewayToken}`,
      },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      logger?.warn?.(
        `[pinchy-audit] audit endpoint returned ${res.status} for ${payload.phase} ${payload.toolName}`
      );
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger?.warn?.(
      `[pinchy-audit] failed to post ${payload.phase} event for ${payload.toolName}: ${message}`
    );
  }
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

      await postToolAuditEvent(cfg, api.logger, sanitizePayloadFields({
        phase: "start",
        toolName: beforeEvent.toolName,
        params: beforeEvent.params,
        runId: beforeEvent.runId ?? ctx.runId,
        toolCallId: beforeEvent.toolCallId ?? ctx.toolCallId,
        agentId,
        sessionKey: ctx.sessionKey,
        sessionId: ctx.sessionId,
      }));
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

      await postToolAuditEvent(cfg, api.logger, sanitizePayloadFields({
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
      }));
    });
  },
};

export default plugin;
