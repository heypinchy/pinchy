import { readFile, writeFile, mkdir, stat } from "fs/promises";
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
const MAX_IMAGE_BYTES = 25 * 1024 * 1024;
const ALLOWED_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

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

function isSafeFilename(filename: string): boolean {
  if (typeof filename !== "string" || filename.length === 0) return false;
  if (filename !== basename(filename)) return false;
  if (filename.startsWith(".")) return false;
  if (filename.includes("\\")) return false;
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
  let fileStat: { size: number };
  try {
    fileStat = await stat(sourcePath);
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
    throw err;
  }
  if (fileStat.size > MAX_IMAGE_BYTES) {
    return {
      error: errorContent(
        `Image too large: "${filename}" is ${fileStat.size} bytes; max allowed is ${MAX_IMAGE_BYTES}.`
      ),
    };
  }

  const buffer = await readFile(sourcePath);
  return { buffer, sourceName: filename };
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
    validate: (value: unknown) => {
      if (value && typeof value === "object" && "agents" in value) {
        return { ok: true as const, value };
      }
      return { ok: false as const, errors: ["Missing 'agents' key in config"] };
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
