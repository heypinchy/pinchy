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

import { constants } from "node:fs";
import { chown as fsChown, copyFile, mkdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  // `mediaPaths`/`mediaTypes` are untyped at the SDK boundary: OpenClaw pairs
  // them by array index and `mediaTypes` may be shorter than `mediaPaths` (or
  // absent). Kept as `unknown` here and validated at runtime in extractMedia.
  metadata?: { mediaPaths?: unknown; mediaTypes?: unknown };
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
      ctx: MessageHookContext,
    ) => Promise<void> | void,
  ) => void;
}

interface CapturedMedia {
  path: string;
  mimeType?: string;
}

interface CaptureChannelMessage {
  channel: string;
  // agentId + peer are derived server-side from sessionKey (single source of truth).
  sessionKey: string;
  direction: "inbound" | "outbound";
  externalId: string;
  content: string;
  sentAt: number;
  // Only mirrored results reach a capturable payload: the handler mirrors
  // BEFORE building the payload and passes `undefined` when it didn't mirror,
  // so every `media` entry that lands here carries the per-file `outcome` the
  // capture route audits (MirrorMediaResult, not the raw extracted CapturedMedia).
  media?: MirrorMediaResult[];
}

// Mirrors the server schema's cap (captureChannelMessageSchema, media.max(20))
// so an oversized album is trimmed here instead of the whole message 400ing.
const MAX_MEDIA = 20;

/**
 * Extract captured media from a message_received event's `metadata`. OpenClaw
 * pairs `mediaPaths[i]` with `mediaTypes[i]` by index; `mediaTypes` may be
 * shorter than `mediaPaths` or absent entirely, so a missing type is dropped
 * rather than defaulted. Returns undefined when there's nothing usable so
 * callers can omit the key entirely instead of sending `media: []`.
 */
function extractMedia(event: {
  metadata?: { mediaPaths?: unknown; mediaTypes?: unknown };
}): CapturedMedia[] | undefined {
  const mediaPaths = event.metadata?.mediaPaths;
  if (!Array.isArray(mediaPaths)) return undefined;
  const mediaTypes = Array.isArray(event.metadata?.mediaTypes)
    ? event.metadata.mediaTypes
    : [];

  const media: CapturedMedia[] = [];
  for (let i = 0; i < mediaPaths.length && media.length < MAX_MEDIA; i++) {
    const path = mediaPaths[i];
    if (typeof path !== "string" || path.length === 0) continue;
    const mimeType = mediaTypes[i];
    media.push(
      typeof mimeType === "string" && mimeType.length > 0
        ? { path, mimeType }
        : { path },
    );
  }
  return media.length > 0 ? media : undefined;
}

// Where THIS container (root inside the `openclaw` service) sees OpenClaw's
// inbound media store and the shared agent workspaces. Unlike the web
// container, this plugin runs as root, which is why the copy lives here: web
// runs as uid 999 and gets EACCES on OpenClaw's media dirs (OpenClaw chmods
// them 0700 on every write). Hardcoded, matching pinchy-odoo's WORKSPACE_ROOT
// pattern — injectable only via mirrorMedia()'s params, for tests.
const MEDIA_INBOUND_DIR = "/root/.openclaw/media/inbound";
const WORKSPACE_ROOT = "/root/.openclaw/workspaces";

// Mirrors the odoo_attach_file cap (packages/plugins/pinchy-odoo) so a single
// oversized Telegram media file can't blow past the same ceiling already
// enforced for outbound attachments.
export const MAX_MIRRORED_MEDIA_BYTES = 25 * 1024 * 1024;

// The web process creates the per-agent uploads dir as uid/gid 999 so it can
// later write new uploads there with O_EXCL. This plugin runs as root, so any
// directory/file IT creates in that shared volume would otherwise land
// root-owned, which would then lock the web process out of a dir it needs to
// keep writing into (and make plugin-copied files look un-web-owned). Every
// directory/file this plugin creates is chowned back to uid/gid 999,
// best-effort — a chown failure (e.g. no CAP_CHOWN, non-Linux test host) must
// never fail the underlying copy, just leave ownership as-is.
const UPLOADS_UID = 999;
const UPLOADS_GID = 999;

type ChownImpl = (path: string, uid: number, gid: number) => Promise<void>;

async function bestEffortChown(path: string, chownImpl: ChownImpl): Promise<void> {
  try {
    await chownImpl(path, UPLOADS_UID, UPLOADS_GID);
  } catch {
    // Best-effort — see UPLOADS_UID/UPLOADS_GID comment above.
  }
}

// Matches pinchy-odoo's isSafeFilename and the now-removed
// packages/web/src/server/channel-media.ts: plain basename (no directory
// component survives basename() on Linux), no dotfiles, no backslashes/NUL
// bytes that could confuse a downstream consumer.
function isSafeBasename(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (name !== basename(name)) return false;
  if (name.startsWith(".")) return false;
  if (name.includes("\\") || name.includes("\0")) return false;
  return true;
}

export interface MirrorMediaResult {
  /** The ORIGINAL reported path (not the resolved source or basename) — the
   *  route/audit layer derives the basename itself, keeping the payload
   *  shape stable regardless of how mirroring resolved the file. */
  path: string;
  mimeType?: string;
  outcome: "success" | "failure";
  bytes?: number;
  error?: string;
}

function buildResult(
  path: string,
  mimeType: string | undefined,
  outcome: "success" | "failure",
  extra: { bytes?: number; error?: string } = {},
): MirrorMediaResult {
  return {
    path,
    ...(mimeType !== undefined ? { mimeType } : {}),
    outcome,
    ...(extra.bytes !== undefined ? { bytes: extra.bytes } : {}),
    ...(extra.error !== undefined ? { error: extra.error } : {}),
  };
}

/**
 * Copy OpenClaw inbound media files into the agent's workspace uploads dir,
 * preserving the basename — this is the deterministic contract the agent
 * relies on: a `[media attached: …/<basename>]` hint in the message means
 * `uploads/<basename>` exists.
 *
 * Trust model: `entries[].path` is data extracted from an OpenClaw hook
 * event's metadata, NOT a trusted filesystem path — only its basename is
 * used, and it is resolved against OUR OWN inbound dir (`inboundDir`/
 * `MEDIA_INBOUND_DIR`), never the reported directory component. The resolved
 * source's realpath must still land inside the inbound dir (symlink defense:
 * a symlink planted in the inbound dir pointing elsewhere on the filesystem
 * resolves outside this prefix and is rejected).
 *
 * Copy uses `COPYFILE_EXCL` so it never overwrites an existing file; an
 * `EEXIST` from a prior successful copy of the same basename (retry /
 * redelivery) is treated as success, making the whole operation idempotent.
 * This treats a same-basename collision as "already mirrored", which is safe
 * ONLY because OpenClaw mints globally-unique basenames for inbound media
 * (photos are pure UUIDs, documents carry a `---<uuid>` suffix — see
 * reference_openclaw_media_store), so an EEXIST is genuinely the same file,
 * never a distinct file that happens to share a name. If a future channel
 * ever supplies caller-controlled, non-unique basenames, this branch would
 * silently skip the new file and must be revisited (e.g. content hash check).
 *
 * Per-file best effort: each entry is processed independently, so one
 * missing/unsafe/oversized file never blocks the rest of the batch.
 *
 * agentId is validated defensively: it is normally derived from a parsed
 * sessionKey by the caller (register()'s message_received handler), but a
 * value containing `/`, `\`, or `..` is still rejected here rather than ever
 * being joined into a filesystem path — every entry is reported as a
 * failure instead of touching the filesystem.
 */
export async function mirrorMedia(
  entries: CapturedMedia[],
  params: {
    agentId: string;
    /** Test injection point; defaults to MEDIA_INBOUND_DIR. */
    inboundDir?: string;
    /** Test injection point; defaults to WORKSPACE_ROOT. */
    workspaceRoot?: string;
    /** Test injection point; defaults to fs.chown. */
    chownImpl?: ChownImpl;
  },
): Promise<MirrorMediaResult[]> {
  const { agentId } = params;
  const inboundDir = params.inboundDir ?? MEDIA_INBOUND_DIR;
  const workspaceRoot = params.workspaceRoot ?? WORKSPACE_ROOT;
  const chownImpl = params.chownImpl ?? fsChown;

  if (!agentId || agentId.includes("/") || agentId.includes("\\") || agentId.includes("..")) {
    return entries.map((item) =>
      buildResult(item.path, item.mimeType, "failure", { error: "invalid agentId" }),
    );
  }

  const uploadsDir = join(workspaceRoot, agentId, "uploads");

  const results: MirrorMediaResult[] = [];
  for (const item of entries) {
    results.push(await mirrorOne(item, inboundDir, uploadsDir, chownImpl));
  }
  return results;
}

async function mirrorOne(
  item: CapturedMedia,
  inboundDir: string,
  uploadsDir: string,
  chownImpl: ChownImpl,
): Promise<MirrorMediaResult> {
  const { path: originalPath, mimeType } = item;
  const filename = basename(originalPath);

  if (!isSafeBasename(filename)) {
    return buildResult(originalPath, mimeType, "failure", {
      error: `unsafe filename: ${filename}`,
    });
  }

  try {
    // Resolve strictly against OUR inbound dir — the reported directory
    // component (if any) was already discarded by basename() above.
    const candidateSource = join(inboundDir, filename);

    let realSource: string;
    let realInboundDir: string;
    try {
      [realSource, realInboundDir] = await Promise.all([
        realpath(candidateSource),
        realpath(inboundDir),
      ]);
    } catch (err) {
      return buildResult(originalPath, mimeType, "failure", {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Symlink defense: the resolved real path must still be a direct child
    // of the real inbound dir.
    if (realSource !== join(realInboundDir, filename)) {
      return buildResult(originalPath, mimeType, "failure", {
        error: "source resolves outside the inbound directory",
      });
    }

    const sourceStat = await stat(realSource);
    if (!sourceStat.isFile()) {
      return buildResult(originalPath, mimeType, "failure", {
        error: "source is not a regular file",
      });
    }
    if (sourceStat.size > MAX_MIRRORED_MEDIA_BYTES) {
      return buildResult(originalPath, mimeType, "failure", {
        error: `file exceeds ${MAX_MIRRORED_MEDIA_BYTES} byte cap (${sourceStat.size} bytes)`,
      });
    }

    const target = join(uploadsDir, filename);
    const targetDir = dirname(target);
    let targetDirExisted = true;
    try {
      await stat(targetDir);
    } catch {
      targetDirExisted = false;
    }
    await mkdir(targetDir, { recursive: true });
    if (!targetDirExisted) await bestEffortChown(targetDir, chownImpl);

    try {
      await copyFile(realSource, target, constants.COPYFILE_EXCL);
      // Only chown a file THIS call actually copied — see UPLOADS_UID/GID
      // comment above.
      await bestEffortChown(target, chownImpl);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      // Already mirrored by a prior run (retry / redelivery) — idempotent success.
    }

    return buildResult(originalPath, mimeType, "success", { bytes: sourceStat.size });
  } catch (err) {
    return buildResult(originalPath, mimeType, "failure", {
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// Channels whose direct conversations Pinchy mirrors. Widen to add Slack etc.
const CAPTURED_CHANNELS = new Set(["telegram"]);

// Strip trailing slashes without a regex: `/\/+$/` trips CodeQL's
// js/polynomial-redos heuristic. A linear scan is unambiguously safe.
function normalizeBaseUrl(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return url.slice(0, end);
}

/**
 * Parse `agent:<agentId>:direct:<peer>` → { agentId, peer }. Returns null for
 * any key that isn't a DIRECT session (group/other scopes are not mirrored).
 * Telegram direct keys carry no trailing chat segment, so `peer` is the final
 * segment.
 */
function parseDirectSessionKey(
  sessionKey: string | undefined,
): { agentId: string; peer: string } | null {
  if (!sessionKey) return null;
  const m = /^agent:([^:]+):direct:([^:]+)$/.exec(sessionKey);
  return m ? { agentId: m[1], peer: m[2] } : null;
}

/**
 * Decide whether inbound media on this event should be mirrored into an agent
 * workspace — and, if so, for which agent. Returns null (skip the copy) unless
 * the channel is one Pinchy captures AND the session is a direct (1:1) one.
 *
 * This gate MUST match buildPayload's own (channel + direct-session) checks,
 * because the copy happens BEFORE buildPayload runs. Without it, a message on
 * a non-captured channel would have its media copied into `uploads/` even
 * though buildPayload then drops the message — an un-audited workspace write
 * (the copy is only ever audited via the capture POST buildPayload gates).
 * Sharing CAPTURED_CHANNELS keeps the two gates from drifting.
 */
function shouldMirror(
  channel: string | undefined,
  sessionKey: string | undefined,
): { agentId: string } | null {
  if (!channel || !CAPTURED_CHANNELS.has(channel)) return null;
  const parsed = parseDirectSessionKey(sessionKey);
  return parsed ? { agentId: parsed.agentId } : null;
}

// Small deterministic hash for the surrogate externalId used when a channel
// hook omits a message id. Stable across retries so dedup still works.
function djb2(str: string): string {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = (h * 33) ^ str.charCodeAt(i);
  return (h >>> 0).toString(36);
}

function surrogateId(
  direction: string,
  content: string,
  sentAt: number,
): string {
  return `surrogate:${direction}:${sentAt}:${djb2(content)}`;
}

const MAX_RETRIES = 2;

async function postChannelMessage(
  cfg: PluginConfig,
  logger: PluginLogger | undefined,
  payload: CaptureChannelMessage,
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
          `[pinchy-transcript] capture rejected (${res.status}) for ${payload.direction} ${payload.channel} message; dropping`,
        );
        return;
      }
      lastError = new Error(`capture endpoint returned ${res.status}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }

    if (attempt < MAX_RETRIES) {
      logger?.warn?.(
        `[pinchy-transcript] capture failed (attempt ${attempt + 1}/${MAX_RETRIES + 1}), retrying: ${lastError?.message}`,
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
  media?: MirrorMediaResult[];
}): CaptureChannelMessage | null {
  const { channel, sessionKey, direction, content, messageId, sentAt, media } =
    args;
  if (!channel || !CAPTURED_CHANNELS.has(channel)) return null;
  // Only mirror DIRECT (1:1) conversations; the endpoint re-derives agent+peer
  // from this same key, so we just gate on it being a valid direct session.
  if (!parseDirectSessionKey(sessionKey)) return null;
  const text = (content ?? "").trim();
  const hasMedia = !!media && media.length > 0;
  if (!text && !hasMedia) return null;
  // A photo-only message often has empty content (OpenClaw's own placeholder
  // isn't guaranteed on every path). The capture schema requires non-empty
  // content and the mirror UI renders it directly, so substitute a stable
  // placeholder rather than dropping media-only messages.
  const finalContent = text || "<media>";

  return {
    channel,
    sessionKey: sessionKey!,
    direction,
    externalId: messageId ?? surrogateId(direction, finalContent, sentAt),
    content: finalContent,
    sentAt,
    ...(hasMedia ? { media } : {}),
  };
}

const plugin = {
  id: "pinchy-transcript",
  name: "Pinchy Transcript",
  description:
    "Captures channel conversation messages into Pinchy's durable transcript store.",
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
      return {
        ok: false as const,
        errors: ["Missing required keys in config"],
      };
    },
  },

  register(api: PluginApi) {
    const cfg = api.pluginConfig;
    if (!cfg?.apiBaseUrl || !cfg?.gatewayToken) {
      api.logger?.warn?.(
        "[pinchy-transcript] plugin config is missing apiBaseUrl or gatewayToken",
      );
      return;
    }

    api.on("message_received", async (event, ctx) => {
      const e = event as MessageReceivedEvent;
      const sessionKey = e.sessionKey ?? ctx.sessionKey;
      const extractedMedia = extractMedia(e);
      // Mirror inbound media into the agent's workspace uploads dir (this
      // container runs as root, so — unlike the web process — it can read
      // OpenClaw's 0700 media store) and report the per-file outcome back to
      // Pinchy in the same `media` field, so the capture route can audit
      // `channel.media_mirrored` without ever touching the filesystem itself.
      // The copy is gated by shouldMirror on the SAME (captured channel +
      // direct session) condition buildPayload uses to capture — so we never
      // copy media for a message we'd then drop (which would be an un-audited
      // uploads write). When we don't mirror, media stays out of the payload.
      const mirrorTarget = shouldMirror(ctx.channelId, sessionKey);
      const media =
        mirrorTarget && extractedMedia && extractedMedia.length > 0
          ? await mirrorMedia(extractedMedia, { agentId: mirrorTarget.agentId })
          : undefined;
      const payload = buildPayload({
        channel: ctx.channelId,
        sessionKey,
        direction: "inbound",
        content: e.content,
        messageId: e.messageId,
        sentAt: typeof e.timestamp === "number" ? e.timestamp : Date.now(),
        media,
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
// (mirrorMedia and MAX_MIRRORED_MEDIA_BYTES are already exported inline above.)
export {
  buildPayload,
  parseDirectSessionKey,
  shouldMirror,
  surrogateId,
  postChannelMessage,
  extractMedia,
};
export default plugin;
