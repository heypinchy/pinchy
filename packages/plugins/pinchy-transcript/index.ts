/**
 * pinchy-transcript — captures inbound/outbound channel messages into Pinchy's
 * durable `channel_messages` store (via POST /api/internal/channel-messages), so
 * the read-only conversation mirror renders from Pinchy's own record instead of
 * OpenClaw's session-scoped chat.history. That makes the mirror robust against
 * OpenClaw session semantics (/new resets, the daily reset, compaction, id
 * rotation) and aligns the conversation record with Pinchy's audit/governance
 * model.
 *
 * v1 captures DIRECT (1:1) Telegram conversations — the only channel Pinchy
 * mirrors today. The schema, endpoint, and this plugin are channel-agnostic, so
 * extending to Slack/WhatsApp is just widening CAPTURED_CHANNELS.
 */

interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
}

interface PluginLogger {
  warn?: (message: string) => void;
}

// Channel-message hook shapes (OpenClaw plugin SDK 2026.6.x). Only the fields
// this plugin reads are typed; the SDK objects carry more.
interface MessageHookContext {
  channelId?: string;
  sessionKey?: string;
  senderId?: string;
}

interface MessageReceivedEvent {
  content?: string;
  from?: string;
  senderId?: string;
  sessionKey?: string;
  messageId?: string;
  timestamp?: number;
}

interface MessageSentEvent {
  to?: string;
  content?: string;
  success?: boolean;
  sessionKey?: string;
  messageId?: string;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  logger?: PluginLogger;
  on: (
    hookName: "message_received" | "message_sent",
    handler: (
      event: MessageReceivedEvent | MessageSentEvent,
      ctx: MessageHookContext
    ) => Promise<void> | void
  ) => void;
}

interface CaptureChannelMessage {
  channel: string;
  sessionKey: string;
  peerId: string;
  direction: "inbound" | "outbound";
  externalId: string;
  content: string;
  sentAt: number;
}

// Channels whose direct conversations Pinchy mirrors. Widen to add Slack etc.
const CAPTURED_CHANNELS = new Set(["telegram"]);

function normalizeBaseUrl(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Parse `agent:<agentId>:direct:<peer>` → { agentId, peer }. Returns null for
 * any key that isn't a DIRECT session (group/other scopes are not mirrored).
 * Telegram direct keys carry no trailing chat segment, so `peer` is the final
 * segment.
 */
function parseDirectSessionKey(
  sessionKey: string | undefined
): { agentId: string; peer: string } | null {
  if (!sessionKey) return null;
  const m = /^agent:([^:]+):direct:([^:]+)$/.exec(sessionKey);
  return m ? { agentId: m[1], peer: m[2] } : null;
}

// Small deterministic hash for the surrogate externalId used when a channel
// hook omits a message id. Stable across retries so dedup still works.
function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function surrogateId(direction: string, content: string, sentAt: number): string {
  return `surrogate:${direction}:${sentAt}:${djb2(content)}`;
}

const MAX_RETRIES = 2;

async function postChannelMessage(
  cfg: PluginConfig,
  logger: PluginLogger | undefined,
  payload: CaptureChannelMessage
): Promise<void> {
  const endpoint = `${normalizeBaseUrl(cfg.apiBaseUrl)}/api/internal/channel-messages`;
  let lastError: Error | undefined;

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
      // 2xx = stored (or idempotently skipped). 4xx = our bug; don't retry a
      // request the server will keep rejecting. 5xx = transient; retry.
      if (res.ok) return;
      if (res.status < 500) {
        logger?.warn?.(
          `[pinchy-transcript] capture rejected (${res.status}) for ${payload.direction} ${payload.channel} message; dropping`
        );
        return;
      }
      lastError = new Error(`capture endpoint returned ${res.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < MAX_RETRIES) {
      logger?.warn?.(
        `[pinchy-transcript] capture failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying: ${lastError?.message}`
      );
    }
  }
  throw lastError;
}

/**
 * Build a capture payload from a channel message, or null if it should be
 * skipped: non-mirrored channel, non-direct session, or empty content.
 */
function buildPayload(args: {
  channel: string | undefined;
  sessionKey: string | undefined;
  direction: "inbound" | "outbound";
  content: string | undefined;
  messageId: string | undefined;
  sentAt: number;
}): CaptureChannelMessage | null {
  const { channel, sessionKey, direction, content, messageId, sentAt } = args;
  if (!channel || !CAPTURED_CHANNELS.has(channel)) return null;
  const direct = parseDirectSessionKey(sessionKey);
  if (!direct) return null;
  const text = (content ?? "").trim();
  if (!text) return null;

  return {
    channel,
    sessionKey: sessionKey!,
    peerId: direct.peer,
    direction,
    externalId: messageId ?? surrogateId(direction, text, sentAt),
    content: text,
    sentAt,
  };
}

const plugin = {
  id: "pinchy-transcript",
  name: "Pinchy Transcript",
  description: "Captures channel conversation messages into Pinchy's durable transcript store.",
  configSchema: {
    validate: (value: unknown) => {
      if (value && typeof value === "object" && "apiBaseUrl" in value && "gatewayToken" in value) {
        return { ok: true as const, value };
      }
      return { ok: false as const, errors: ["Missing required keys in config"] };
    },
  },

  register(api: PluginApi) {
    const cfg = api.pluginConfig;
    if (!cfg?.apiBaseUrl || !cfg?.gatewayToken) {
      api.logger?.warn?.("[pinchy-transcript] plugin config is missing apiBaseUrl or gatewayToken");
      return;
    }

    api.on("message_received", async (event, ctx) => {
      const e = event as MessageReceivedEvent;
      const payload = buildPayload({
        channel: ctx.channelId,
        sessionKey: e.sessionKey ?? ctx.sessionKey,
        direction: "inbound",
        content: e.content,
        messageId: e.messageId,
        sentAt: typeof e.timestamp === "number" ? e.timestamp : Date.now(),
      });
      if (payload) await postChannelMessage(cfg, api.logger, payload);
    });

    api.on("message_sent", async (event, ctx) => {
      const e = event as MessageSentEvent;
      // Only record replies that were actually delivered to the channel.
      if (e.success === false) return;
      const payload = buildPayload({
        channel: ctx.channelId,
        sessionKey: e.sessionKey ?? ctx.sessionKey,
        direction: "outbound",
        content: e.content,
        messageId: e.messageId,
        // message_sent carries no timestamp; stamp at delivery time.
        sentAt: Date.now(),
      });
      if (payload) await postChannelMessage(cfg, api.logger, payload);
    });
  },
};

// Exported for unit tests; the default export is the plugin OpenClaw loads.
export { buildPayload, parseDirectSessionKey, surrogateId, postChannelMessage };
export default plugin;
