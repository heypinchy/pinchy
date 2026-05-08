import { createHash } from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { join, parse as parsePath } from "path";
import { getWorkspacePath } from "@/lib/workspace";

const UPLOADS_SUBDIR = "uploads";

export interface PersistAttachmentParams {
  agentId: string;
  filename: string;
  mimeType: string; // stored in audit log by the caller (not used inside this function)
  buffer: Buffer;
}

export interface PersistAttachmentResult {
  relativePath: string;
  reused: boolean;
  contentHash: string;
}

export async function persistAttachment(
  params: PersistAttachmentParams
): Promise<PersistAttachmentResult> {
  const { agentId, filename, buffer } = params;

  const agentWorkspace = getWorkspacePath(agentId);
  const uploadsDir = join(agentWorkspace, UPLOADS_SUBDIR);
  mkdirSync(uploadsDir, { recursive: true });

  const contentHash = createHash("sha256").update(buffer).digest("hex");
  // Note: resolveCollision has a TOCTOU race if two requests for the same
  // agent/filename arrive concurrently — both could resolve the same free slot
  // and the slower rename would clobber the faster one. Acceptable for MVP
  // single-user agents; file locking would be needed for high-concurrency scenarios.
  const resolved = resolveCollision(uploadsDir, filename, buffer, contentHash);

  if (resolved.reused) {
    return {
      relativePath: `${UPLOADS_SUBDIR}/${resolved.filename}`,
      reused: true,
      contentHash,
    };
  }

  const finalPath = join(uploadsDir, resolved.filename);
  const tmpPath = `${finalPath}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmpPath, buffer);
  renameSync(tmpPath, finalPath);

  return {
    relativePath: `${UPLOADS_SUBDIR}/${resolved.filename}`,
    reused: false,
    contentHash,
  };
}

function resolveCollision(
  uploadsDir: string,
  filename: string,
  buffer: Buffer,
  contentHash: string
): { filename: string; reused: boolean } {
  const candidatePath = join(uploadsDir, filename);
  if (!existsSync(candidatePath)) {
    return { filename, reused: false };
  }
  const existing = readFileSync(candidatePath);
  if (createHash("sha256").update(existing).digest("hex") === contentHash) {
    return { filename, reused: true };
  }
  const { name, ext } = parsePath(filename);
  for (let i = 1; i < 1000; i++) {
    const next = `${name} (${i})${ext}`;
    const nextPath = join(uploadsDir, next);
    if (!existsSync(nextPath)) {
      return { filename: next, reused: false };
    }
    const buf = readFileSync(nextPath);
    if (createHash("sha256").update(buf).digest("hex") === contentHash) {
      return { filename: next, reused: true };
    }
  }
  throw new Error(`Too many collisions for ${filename}`);
}
