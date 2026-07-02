import { writeFile, mkdir, stat, open } from "fs/promises";
import { constants as fsConstants } from "fs";
import { basename, extname, join } from "path";
import { randomBytes } from "crypto";
import {
  cropImage,
  resizeImage,
  rotateImage,
  convertImage,
  extensionForFormat,
  type ConvertFormat,
  type ResizeFit,
} from "./transform";

const WORKSPACE_ROOT_DEFAULT = "/root/.openclaw/workspaces";
const MAX_IMAGE_BYTES_DEFAULT = 25 * 1024 * 1024;
// `.gif` is intentionally NOT supported: sharp's default pipeline drops all
// frames but the first, which would silently destroy animated GIFs. If a real
// use case for static GIF processing emerges, switch to `{ animated: true }`
// in sharp() and re-add `.gif` here.
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp"]);

interface PluginToolContext {
  agentId?: string;
}

interface ContentBlock {
  type: string;
  text: string;
}

interface AgentImageConfig {
  tools: string[];
}

interface PluginConfig {
  agents: Record<string, AgentImageConfig>;
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
    content: ContentBlock[];
    isError?: boolean;
    details?: unknown;
  }>;
}

function workspaceRoot(): string {
  return process.env.PINCHY_IMAGE_WORKSPACE_ROOT || WORKSPACE_ROOT_DEFAULT;
}

function maxImageBytes(): number {
  const raw = process.env.PINCHY_IMAGE_MAX_BYTES;
  if (!raw) return MAX_IMAGE_BYTES_DEFAULT;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : MAX_IMAGE_BYTES_DEFAULT;
}

function isSafeFilename(filename: string): boolean {
  if (typeof filename !== "string" || filename.length === 0) return false;
  if (filename !== basename(filename)) return false;
  if (filename.startsWith(".")) return false;
  if (filename.includes("\\")) return false;
  // NUL bytes terminate paths in POSIX syscalls — Node usually throws, but
  // some code paths (logging, audit) would still see the truncated string.
  if (filename.includes("\0")) return false;
  return true;
}

function isSupportedExtension(filename: string): boolean {
  return ALLOWED_EXTENSIONS.has(extname(filename).toLowerCase());
}

function agentUploadsDir(agentId: string): string {
  return join(workspaceRoot(), agentId, "uploads");
}

function generateOutputFilename(sourceName: string, ext: string): string {
  const baseNoExt = basename(sourceName, extname(sourceName));
  const token = randomBytes(4).toString("hex");
  return `${baseNoExt}-${token}${ext.startsWith(".") ? ext : `.${ext}`}`;
}

function errorContent(message: string): { isError: true; content: ContentBlock[] } {
  return { isError: true, content: [{ type: "text", text: message }] };
}

async function readSourceImage(
  agentId: string,
  filename: unknown
): Promise<{ buffer: Buffer; sourceName: string } | { error: { isError: true; content: ContentBlock[] } }> {
  if (typeof filename !== "string" || !isSafeFilename(filename)) {
    return {
      error: errorContent(
        `Invalid filename: ${typeof filename === "string" ? `"${filename}"` : "<missing>"}. ` +
          `Must be a plain filename (no path separators, no leading dot, no "..").`
      ),
    };
  }
  if (!isSupportedExtension(filename)) {
    return {
      error: errorContent(
        `Unsupported file extension for "${filename}". Allowed: ${[...ALLOWED_EXTENSIONS].join(", ")}.`
      ),
    };
  }

  const sourcePath = join(agentUploadsDir(agentId), filename);
  // Atomic open with O_NOFOLLOW closes the TOCTOU window: a separate `lstat`
  // followed by `readFile` would race against an attacker swapping the
  // upload entry between the check and the read. O_NOFOLLOW also rejects
  // symlinks in the final path component (ELOOP), serving as the workspace
  // boundary guard. All subsequent size/type checks run against the held file
  // descriptor via fstat, so the file we measure is the file we read.
  const O_NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0;
  let handle;
  try {
    handle = await open(sourcePath, fsConstants.O_RDONLY | O_NOFOLLOW);
  } catch (err) {
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "ENOENT") {
      return {
        error: errorContent(
          `File not found: "${filename}". Make sure the image was uploaded before calling this tool.`
        ),
      };
    }
    if (code === "ELOOP") {
      return {
        error: errorContent(
          `Refusing to read "${filename}": file is a symlink, only regular files are allowed.`
        ),
      };
    }
    throw err;
  }
  try {
    const statRes = await handle.stat();
    if (!statRes.isFile()) {
      return {
        error: errorContent(`Refusing to read "${filename}": not a regular file.`),
      };
    }
    const maxBytes = maxImageBytes();
    if (statRes.size > maxBytes) {
      return {
        error: errorContent(
          `Image too large: "${filename}" is ${statRes.size} bytes; max allowed is ${maxBytes}.`
        ),
      };
    }
    const buffer = await handle.readFile();
    return { buffer, sourceName: filename };
  } finally {
    await handle.close();
  }
}

async function writeOutputImage(
  agentId: string,
  sourceName: string,
  buffer: Buffer,
  ext: string
): Promise<string> {
  const uploadsDir = agentUploadsDir(agentId);
  await mkdir(uploadsDir, { recursive: true });
  let outName = generateOutputFilename(sourceName, ext);
  // Collisions are astronomically unlikely with 4 random bytes, but guard the
  // tail call so we never silently overwrite an existing file the agent might
  // still reference.
  for (let i = 0; i < 5; i++) {
    try {
      await stat(join(uploadsDir, outName));
      outName = generateOutputFilename(sourceName, ext);
    } catch {
      break;
    }
  }
  await writeFile(join(uploadsDir, outName), buffer);
  return outName;
}

function jsonResult(id: string): { content: ContentBlock[] } {
  return { content: [{ type: "text", text: JSON.stringify({ id }) }] };
}

function getAgentConfig(
  agents: Record<string, AgentImageConfig>,
  agentId: string
): AgentImageConfig | null {
  return agents[agentId] ?? null;
}

function hasTool(
  agents: Record<string, AgentImageConfig>,
  agentId: string,
  toolName: string
): boolean {
  const cfg = getAgentConfig(agents, agentId);
  return !!cfg && cfg.tools.includes(toolName);
}

const plugin = {
  id: "pinchy-image",
  name: "Pinchy Image",
  description: "Image transformation tools (crop, resize, rotate, convert) for agent attachments.",
  configSchema: {
    // This is a smoke-check only. The authoritative schema lives in
    // openclaw.plugin.json and is enforced by OpenClaw's Ajv loader against
    // additionalProperties: false. We still verify that `agents` is a plain
    // object (not null, not array, not a primitive) so that mis-shaped configs
    // fail loudly here too.
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "agents" in value &&
        (value as { agents: unknown }).agents !== null &&
        typeof (value as { agents: unknown }).agents === "object" &&
        !Array.isArray((value as { agents: unknown }).agents)
      ) {
        return { ok: true as const, value };
      }
      return {
        ok: false as const,
        errors: ["Config must include an `agents` object"],
      };
    },
  },

  register(api: PluginApi) {
    const agents = api.pluginConfig?.agents ?? {};

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId || !hasTool(agents, agentId, "image_crop")) return null;
        return {
          name: "image_crop",
          label: "Crop Image",
          description:
            "Crop an uploaded image to a rectangle. Returns the filename of a new image in the agent's uploads directory. " +
            "Source must be a plain filename of an already-uploaded image (no path).",
          parameters: {
            type: "object",
            properties: {
              source: { type: "string", description: "Filename of the uploaded image to crop." },
              x: { type: "integer", minimum: 0, description: "Left offset in pixels." },
              y: { type: "integer", minimum: 0, description: "Top offset in pixels." },
              width: { type: "integer", minimum: 1, description: "Crop width in pixels." },
              height: { type: "integer", minimum: 1, description: "Crop height in pixels." },
            },
            required: ["source", "x", "y", "width", "height"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const read = await readSourceImage(agentId, params.source);
              if ("error" in read) return read.error;
              const out = await cropImage(read.buffer, {
                x: params.x as number,
                y: params.y as number,
                width: params.width as number,
                height: params.height as number,
              });
              const ext = extname(read.sourceName);
              const id = await writeOutputImage(agentId, read.sourceName, out, ext);
              return jsonResult(id);
            } catch (err) {
              return errorContent(err instanceof Error ? err.message : "Unknown error");
            }
          },
        };
      },
      { name: "image_crop" }
    );

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId || !hasTool(agents, agentId, "image_resize")) return null;
        return {
          name: "image_resize",
          label: "Resize Image",
          description:
            "Resize an uploaded image. At least one of width or height must be given. " +
            "Supported fit modes: cover, contain, fill, inside (default: inside, preserves aspect ratio).",
          parameters: {
            type: "object",
            properties: {
              source: { type: "string", description: "Filename of the uploaded image to resize." },
              width: { type: "integer", minimum: 1, description: "Target width in pixels." },
              height: { type: "integer", minimum: 1, description: "Target height in pixels." },
              fit: {
                type: "string",
                enum: ["cover", "contain", "fill", "inside"],
                description: "Resize fit mode. Default: inside.",
              },
            },
            required: ["source"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const read = await readSourceImage(agentId, params.source);
              if ("error" in read) return read.error;
              const out = await resizeImage(read.buffer, {
                width: params.width as number | undefined,
                height: params.height as number | undefined,
                fit: params.fit as ResizeFit | undefined,
              });
              const ext = extname(read.sourceName);
              const id = await writeOutputImage(agentId, read.sourceName, out, ext);
              return jsonResult(id);
            } catch (err) {
              return errorContent(err instanceof Error ? err.message : "Unknown error");
            }
          },
        };
      },
      { name: "image_resize" }
    );

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId || !hasTool(agents, agentId, "image_rotate")) return null;
        return {
          name: "image_rotate",
          label: "Rotate Image",
          description:
            "Rotate an uploaded image by the given angle in degrees. EXIF orientation is normalised first.",
          parameters: {
            type: "object",
            properties: {
              source: { type: "string", description: "Filename of the uploaded image to rotate." },
              angle: { type: "number", description: "Rotation angle in degrees (clockwise)." },
            },
            required: ["source", "angle"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const read = await readSourceImage(agentId, params.source);
              if ("error" in read) return read.error;
              const out = await rotateImage(read.buffer, { angle: params.angle as number });
              const ext = extname(read.sourceName);
              const id = await writeOutputImage(agentId, read.sourceName, out, ext);
              return jsonResult(id);
            } catch (err) {
              return errorContent(err instanceof Error ? err.message : "Unknown error");
            }
          },
        };
      },
      { name: "image_rotate" }
    );

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId || !hasTool(agents, agentId, "image_convert")) return null;
        return {
          name: "image_convert",
          label: "Convert Image Format",
          description:
            "Convert an uploaded image to a different format. Supported formats: png, jpeg, webp.",
          parameters: {
            type: "object",
            properties: {
              source: { type: "string", description: "Filename of the uploaded image to convert." },
              format: {
                type: "string",
                enum: ["png", "jpeg", "webp"],
                description: "Target image format.",
              },
            },
            required: ["source", "format"],
            additionalProperties: false,
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              const read = await readSourceImage(agentId, params.source);
              if ("error" in read) return read.error;
              const format = params.format as ConvertFormat;
              const out = await convertImage(read.buffer, { format });
              const id = await writeOutputImage(
                agentId,
                read.sourceName,
                out,
                `.${extensionForFormat(format)}`
              );
              return jsonResult(id);
            } catch (err) {
              return errorContent(err instanceof Error ? err.message : "Unknown error");
            }
          },
        };
      },
      { name: "image_convert" }
    );
  },
};

export default plugin;
