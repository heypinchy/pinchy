import { constants } from "fs";
import { copyFile, mkdir, realpath, stat } from "fs/promises";
import { basename, dirname, join } from "path";
import { getWorkspaceBasePath } from "@/lib/workspace";

/** Where the web container sees OpenClaw's inbound media store (shared `openclaw-config` volume). */
const DEFAULT_MEDIA_INBOUND_PATH = "/openclaw-config/media/inbound";
export function getMediaInboundPath(): string {
  return process.env.MEDIA_INBOUND_PATH ?? DEFAULT_MEDIA_INBOUND_PATH;
}

// Matches pinchy-odoo's isSafeFilename (packages/plugins/pinchy-odoo/index.ts):
// plain basename (no directory component survives basename on Linux), no
// dotfiles, no backslashes/NUL bytes that could confuse a downstream consumer.
function isSafeBasename(name: string): boolean {
  if (typeof name !== "string" || name.length === 0 || name.length > 255) return false;
  if (name !== basename(name)) return false;
  if (name.startsWith(".")) return false;
  if (name.includes("\\") || name.includes("\0")) return false;
  return true;
}

// Mirrors the odoo_attach_file cap (packages/plugins/pinchy-odoo) so a single
// oversized Telegram media file can't blow past the same ceiling we already
// enforce for outbound attachments.
export const MAX_MIRRORED_MEDIA_BYTES = 25 * 1024 * 1024;

export interface MirroredMediaResult {
  filename: string;
  mimeType: string | null;
  bytes: number | null;
  outcome: "success" | "failure";
  error?: string;
}

/**
 * Copy OpenClaw inbound media files into the agent's workspace uploads dir,
 * preserving the basename — this is the deterministic contract the agent
 * relies on: a `[media attached: …/<basename>]` hint in the message means
 * `uploads/<basename>` exists.
 *
 * Trust model: `media[].path` is data reported by the channel-capture plugin,
 * NOT a trusted filesystem path — only its basename is used, and it is
 * resolved against OUR OWN inbound dir (`inboundDir`/`getMediaInboundPath()`),
 * never the reported directory component. The resolved source's realpath must
 * still land inside the inbound dir (symlink defense: a malicious or buggy
 * plugin could otherwise plant a symlink in the inbound dir pointing anywhere
 * on the container filesystem).
 *
 * Copy uses `COPYFILE_EXCL` so it never overwrites an existing file; an
 * `EEXIST` from a prior successful copy of the same basename (retry /
 * redelivery) is treated as success, making the whole operation idempotent.
 *
 * Per-file best effort: each entry in `media` is processed independently, so
 * one missing/unsafe/oversized file never blocks the rest of the batch.
 */
export async function mirrorChannelMedia(params: {
  agentId: string;
  media: Array<{ path: string; mimeType?: string }>;
  /** Test injection point; defaults to getMediaInboundPath(). */
  inboundDir?: string;
  /** Test injection point; defaults to getWorkspaceBasePath(). */
  workspaceRoot?: string;
}): Promise<MirroredMediaResult[]> {
  const { agentId, media } = params;
  const inboundDir = params.inboundDir ?? getMediaInboundPath();
  const workspaceRoot = params.workspaceRoot ?? getWorkspaceBasePath();

  // agentId is not attacker-controlled data here (Task 3's route derives it
  // from the resolved sessionKey), but a path-traversal value would still be
  // a serious bug if one ever reached this far — fail loudly rather than
  // silently writing outside the intended uploads directory.
  if (!agentId || agentId.includes("/") || agentId.includes("\\") || agentId.includes("..")) {
    throw new Error(`mirrorChannelMedia: invalid agentId: ${agentId}`);
  }

  const uploadsDir = join(workspaceRoot, agentId, "uploads");

  const results: MirroredMediaResult[] = [];
  for (const item of media) {
    results.push(await mirrorOne(item, inboundDir, uploadsDir));
  }
  return results;
}

async function mirrorOne(
  item: { path: string; mimeType?: string },
  inboundDir: string,
  uploadsDir: string
): Promise<MirroredMediaResult> {
  const filename = basename(item.path);
  const mimeType = item.mimeType ?? null;

  if (!isSafeBasename(filename)) {
    return {
      filename,
      mimeType,
      bytes: null,
      outcome: "failure",
      error: `unsafe filename: ${filename}`,
    };
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
      return {
        filename,
        mimeType,
        bytes: null,
        outcome: "failure",
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // Symlink defense: the resolved real path must still be a direct child
    // of the real inbound dir. A symlink planted in the inbound dir pointing
    // elsewhere on the filesystem resolves outside this prefix and is
    // rejected.
    if (realSource !== join(realInboundDir, filename)) {
      return {
        filename,
        mimeType,
        bytes: null,
        outcome: "failure",
        error: "source resolves outside the inbound directory",
      };
    }

    const sourceStat = await stat(realSource);
    if (!sourceStat.isFile()) {
      return {
        filename,
        mimeType,
        bytes: null,
        outcome: "failure",
        error: "source is not a regular file",
      };
    }
    if (sourceStat.size > MAX_MIRRORED_MEDIA_BYTES) {
      return {
        filename,
        mimeType,
        bytes: null,
        outcome: "failure",
        error: `file exceeds ${MAX_MIRRORED_MEDIA_BYTES} byte cap (${sourceStat.size} bytes)`,
      };
    }

    const target = join(uploadsDir, filename);
    await mkdir(dirname(target), { recursive: true });

    try {
      await copyFile(realSource, target, constants.COPYFILE_EXCL);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;
      // Already mirrored by a prior run (retry / redelivery) — idempotent success.
    }

    return {
      filename,
      mimeType,
      bytes: sourceStat.size,
      outcome: "success",
    };
  } catch (err) {
    return {
      filename,
      mimeType,
      bytes: null,
      outcome: "failure",
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
