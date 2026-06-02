import { readdirSync, statSync, realpathSync } from "fs";
import { readFile, open, writeFile } from "fs/promises";
import { createHash } from "crypto";
import { join, extname, basename } from "path";
import { validateAccess, MAX_FILE_SIZE, MAX_PDF_FILE_SIZE, MAX_DOCX_FILE_SIZE, type AgentFileConfig } from "./validate";
import { extractDocxText } from "./docx-extract";
import { extractPdfText } from "./pdf-extract";
import { formatPdfResult } from "./pdf-format";
import { PdfCache } from "./pdf-cache";
import { createVisionConfig, type VisionApiConfig } from "./pdf-vision-api";
import { runVisionTasks, type AggregatedVisionUsage } from "./pdf-vision-runner";
import { reportUsage } from "./usage-reporter";
import { resolveAgentInfo } from "./resolve-agent-info";

interface PluginToolContext {
  agentId?: string;
}

// Strips the workspace/writePath prefix from an absolute path for audit logging.
// Keeps the last segment of the matched writePath as a marker (e.g. "uploads/result.csv")
// so audit entries don't expose the full container path /root/.openclaw/workspaces/<id>/...
function relativizeWritePath(absolutePath: string, writePaths: readonly string[]): string {
  for (const wp of writePaths) {
    const normalized = wp.replace(/\/+$/, "");
    if (absolutePath === normalized || absolutePath.startsWith(normalized + "/")) {
      const leaf = normalized.split("/").filter(Boolean).pop();
      if (!leaf) return absolutePath;
      const rest = absolutePath.slice(normalized.length).replace(/^\//, "");
      return rest ? `${leaf}/${rest}` : leaf;
    }
  }
  return absolutePath;
}

// Tool results carry either text or an image. The image shape matches
// OpenClaw's `ImageContent` ({ type: "image", data: <base64>, mimeType }) so a
// re-read image is fed back to the model as native multimodal input — the same
// way a freshly uploaded attachment reaches the model on the first turn.
type ContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string };

// Image extensions pinchy_read returns as image content blocks rather than
// utf-8 text. Reading the bytes as utf-8 would hand the model binary garbage
// (issue #420). Keys are lowercase; lookup lowercases the file extension.
// Used only as a fallback — content sniffing (sniffImageMime) takes priority so
// that extensionless uploads (the reported `upload (3)` case) and mislabeled
// files are still detected.
const IMAGE_MIME_TYPES: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  // HEIC/HEIF: iPhone default format, listed in ALLOWED_ATTACHMENT_MIMES. The
  // ISOBMFF container has no single simple magic signature (varies by encoder),
  // so we rely on extension detection only. These are upload-allowed formats and
  // without this entry pinchy_read would return binary garbage.
  ".heic": "image/heic",
  ".heif": "image/heif",
};

// Detect an image from its leading bytes (magic numbers). Pasted/dropped images
// are persisted without a meaningful filename (attachment-pipeline falls back to
// "upload", so on disk they are `upload`, `upload (1)`, …) — extension-based
// detection misses exactly those, which is how #420 manifested. Returns the
// MIME type, or null if the buffer is not a recognized image.
function sniffImageMime(buf: Buffer): string | null {
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 &&
    buf[1] === 0x50 &&
    buf[2] === 0x4e &&
    buf[3] === 0x47 &&
    buf[4] === 0x0d &&
    buf[5] === 0x0a &&
    buf[6] === 0x1a &&
    buf[7] === 0x0a
  ) {
    return "image/png";
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return "image/jpeg";
  }
  if (buf.length >= 6) {
    const gif = buf.toString("ascii", 0, 6);
    if (gif === "GIF87a" || gif === "GIF89a") return "image/gif";
  }
  if (
    buf.length >= 12 &&
    buf.toString("ascii", 0, 4) === "RIFF" &&
    buf.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }
  return null;
}

interface PluginApi {
  pluginConfig?: {
    agents?: Record<string, AgentFileConfig>;
    apiBaseUrl?: string;
    gatewayToken?: string;
  };
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
  ) => Promise<{ content: ContentBlock[]; details?: unknown }>;
}

const SYSTEM_FILES = new Set([
  "Thumbs.db", "thumbs.db",
  "desktop.ini", "Desktop.ini",
  "$RECYCLE.BIN",
  "System Volume Information",
  ".DS_Store",
]);

function getAgentPaths(
  agentConfigs: Record<string, AgentFileConfig>,
  agentId: string
): string[] | null {
  const config = agentConfigs[agentId];
  if (!config) return null;
  return config.allowed_paths;
}

const CACHE_DIR = process.env.PINCHY_PDF_CACHE_DIR ?? "/var/cache/pinchy-files";
let cache: PdfCache | null = null;

function getCache(): PdfCache {
  if (!cache) {
    cache = new PdfCache(CACHE_DIR);
  }
  return cache;
}

async function readPdf(
  realPath: string,
  stats: { size: number; mtimeMs: number },
  visionConfig: VisionApiConfig | null,
): Promise<{ content: ContentBlock[]; visionUsage: AggregatedVisionUsage }> {
  const pdfCache = getCache();
  const zeroUsage: AggregatedVisionUsage = { inputTokens: 0, outputTokens: 0 };

  // Fast path: check cache with just size+mtime (no file read needed)
  const cachedFast = pdfCache.getFast(realPath, stats.size, stats.mtimeMs);
  if (cachedFast) {
    return { content: [{ type: "text", text: cachedFast }], visionUsage: zeroUsage };
  }

  // Cache miss or mtime changed — read file and compute hash
  const fileBuffer = await readFile(realPath);
  const contentHash = createHash("sha256").update(fileBuffer).digest("hex");

  // Slow path: check if content hash matches (mtime changed but content didn't)
  const cachedSlow = pdfCache.getByHash(realPath, contentHash);
  if (cachedSlow) {
    pdfCache.updateMtime(realPath, stats.mtimeMs);
    return { content: [{ type: "text", text: cachedSlow }], visionUsage: zeroUsage };
  }

  const extraction = await extractPdfText(fileBuffer);

  // Call the LLM vision API for scanned pages and embedded images.
  // All calls run in parallel for maximum speed and their token usage is
  // aggregated so the caller can report it to the usage dashboard.
  let visionUsage: AggregatedVisionUsage = zeroUsage;
  if (visionConfig) {
    visionUsage = await runVisionTasks(extraction.pages, visionConfig);

    // Free embedded image data after vision processing
    for (const page of extraction.pages) {
      page.embeddedImages = [];
    }
  }

  const formatted = formatPdfResult(extraction, realPath);

  // Only cache if all pages were successfully processed.
  // If scanned pages still have no text (vision unavailable or failed),
  // don't cache — next read might have vision available.
  const hasUnprocessedScans = extraction.pages.some((p) => p.isScanned && !p.text.trim());
  if (!hasUnprocessedScans) {
    pdfCache.set(realPath, stats.size, stats.mtimeMs, contentHash, formatted);
  }

  return { content: [{ type: "text", text: formatted }], visionUsage };
}

const plugin = {
  id: "pinchy-files",
  name: "Pinchy Files",
  description: "Scoped read-only file access for Pinchy Knowledge Base agents.",
  configSchema: {
    validate: (value: unknown) => {
      if (value && typeof value === "object" && "agents" in value) {
        return { ok: true as const, value };
      }
      return { ok: false as const, errors: ["Missing 'agents' key in config"] };
    },
  },

  register(api: PluginApi) {
    const agentConfigs = api.pluginConfig?.agents ?? {};
    const apiBaseUrl = api.pluginConfig?.apiBaseUrl;
    const gatewayToken = api.pluginConfig?.gatewayToken;

    // Capture runtime APIs for vision (direct LLM API calls for scanned pages)
    const modelAuth = (api as any).runtime?.modelAuth as {
      resolveApiKeyForProvider: (params: { provider: string; cfg: unknown }) => Promise<{ apiKey: string } | null>;
    } | undefined;
    const loadConfig = (api as any).runtime?.config?.loadConfig as
      (() => Record<string, unknown>) | undefined;

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;

        const paths = getAgentPaths(agentConfigs, agentId);
        if (!paths) return null;

        const pathList = paths.join(", ");

        return {
          name: "pinchy_ls",
          label: "List Files",
          description: `List files and directories. Start here first to discover available files. Your knowledge base is at: ${pathList}`,
          parameters: {
            type: "object",
            properties: {
              path: { type: "string", description: `Directory to list. Use one of these paths: ${pathList}` },
            },
            required: ["path"],
          },
          async execute(
            _toolCallId: string,
            params: Record<string, unknown>
          ) {
            try {
              const requestedPath = params.path as string;
              const realPath = realpathSync(requestedPath);
              validateAccess({ allowed_paths: paths }, realPath);

              const entries = readdirSync(realPath);
              const results = entries
                .filter((name) => !name.startsWith(".") && !name.startsWith("~$") && !SYSTEM_FILES.has(name))
                .map((name) => {
                  const fullPath = join(realPath, name);
                  const stats = statSync(fullPath);
                  return {
                    name,
                    type: stats.isDirectory() ? "directory" : "file",
                    size: stats.isFile() ? stats.size : undefined,
                  };
                });

              return {
                content: [
                  { type: "text", text: JSON.stringify(results, null, 2) },
                ],
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return {
                isError: true,
                content: [{ type: "text", text: message }],
              };
            }
          },
        };
      },
      { name: "pinchy_ls" }
    );

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;

        const paths = getAgentPaths(agentConfigs, agentId);
        if (!paths) return null;

        const pathList = paths.join(", ");

        return {
          name: "pinchy_read",
          label: "Read File",
          description: `Read a file's content. Use pinchy_ls first to discover the exact file path. Your knowledge base is at: ${pathList}`,
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: `Full file path to read. Use pinchy_ls to discover available files in: ${pathList}`,
              },
            },
            required: ["path"],
          },
          async execute(
            _toolCallId: string,
            params: Record<string, unknown>
          ) {
            try {
              const requestedPath = params.path as string;
              const realPath = realpathSync(requestedPath);
              validateAccess({ allowed_paths: paths }, realPath);

              const lowerPath = realPath.toLowerCase();
              const isPdf = lowerPath.endsWith(".pdf");
              const isDocx = lowerPath.endsWith(".docx");

              // PDF detection
              if (isPdf) {
                const stats = statSync(realPath);
                if (stats.size > MAX_PDF_FILE_SIZE) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: `File too large (${stats.size} bytes). Maximum: ${MAX_PDF_FILE_SIZE} bytes.`,
                      },
                    ],
                  };
                }

                // Resolve agent name + model from OpenClaw config in one walk.
                // The model drives vision API calls; the name makes rows on
                // the Usage Dashboard readable (agentId alone is opaque).
                let visionConfig: VisionApiConfig | null = null;
                let resolvedAgentName: string | undefined;
                if (modelAuth && loadConfig) {
                  const cfg = loadConfig();
                  const agentInfo = resolveAgentInfo(cfg, agentId);
                  resolvedAgentName = agentInfo.name;
                  if (agentInfo.model) {
                    visionConfig = createVisionConfig({
                      modelAuth,
                      cfg,
                      model: agentInfo.model,
                    });
                  }
                }
                const pdfResult = await readPdf(realPath, stats, visionConfig);

                // Fire-and-forget: report any vision API tokens to Pinchy's
                // internal usage endpoint so they show up on the Usage
                // Dashboard. We intentionally do not await — telemetry must
                // never block or fail a PDF read.
                if (apiBaseUrl && gatewayToken && visionConfig) {
                  void reportUsage(
                    {
                      agentId,
                      agentName: resolvedAgentName ?? agentId,
                      sessionKey: "plugin:pinchy-files",
                      model: visionConfig.model,
                      inputTokens: pdfResult.visionUsage.inputTokens,
                      outputTokens: pdfResult.visionUsage.outputTokens,
                    },
                    { apiBaseUrl, gatewayToken },
                  );
                }

                return { content: pdfResult.content };
              }

              // Non-PDF (.docx, images, text): open the file once and read it
              // through the descriptor — stat for the size gate and read on the
              // SAME open handle. Binding the size check and the read to one fd
              // closes the time-of-check/time-of-use window (CodeQL
              // js/file-system-race): a file swapped after the check can no
              // longer be read in its place.
              const fh = await open(realPath, "r");
              let buffer: Buffer;
              try {
                const { size } = await fh.stat();
                const sizeLimit = isDocx ? MAX_DOCX_FILE_SIZE : MAX_FILE_SIZE;
                if (size > sizeLimit) {
                  return {
                    isError: true,
                    content: [
                      {
                        type: "text",
                        text: `File too large (${size} bytes). Maximum: ${sizeLimit} bytes.`,
                      },
                    ],
                  };
                }
                buffer = await fh.readFile();
              } finally {
                await fh.close();
              }

              // .docx — extract text via mammoth. Reading a .docx as utf-8
              // returns the ZIP archive's binary bytes (starting with "PK"),
              // which is unintelligible to the model.
              if (isDocx) {
                const { text } = await extractDocxText(buffer);
                return { content: [{ type: "text", text }] };
              }

              // Images (detected by content first, then extension as a
              // fallback) are returned as an image content block so the model
              // re-sees the picture natively (issue #420) — the same way a
              // freshly uploaded attachment reaches the model on the first turn.
              // Everything else is returned as utf-8 text, the original behavior.
              const imageMimeType =
                sniffImageMime(buffer) ?? IMAGE_MIME_TYPES[extname(realPath).toLowerCase()];
              if (imageMimeType) {
                return {
                  content: [
                    // A short label gives the model context ("this is the file
                    // you asked about") next to the raw image bytes.
                    { type: "text", text: `Image file: ${basename(realPath)}` },
                    { type: "image", data: buffer.toString("base64"), mimeType: imageMimeType },
                  ],
                };
              }
              return { content: [{ type: "text", text: buffer.toString("utf-8") }] };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return {
                isError: true,
                content: [{ type: "text", text: message }],
              };
            }
          },
        };
      },
      { name: "pinchy_read" }
    );

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;

        const config = agentConfigs[agentId];
        if (!config) return null;

        const writePaths = config.write_paths;
        if (!writePaths || writePaths.length === 0) return null;

        const pathList = writePaths.join(", ");

        return {
          name: "pinchy_write",
          label: "Write File",
          description: `Write content to a file. Fails if the file already exists — set overwrite=true to replace. Writable paths: ${pathList}`,
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description: `Full file path. Must be under: ${pathList}`,
              },
              content: {
                type: "string",
                description: "Full file content as a string.",
              },
              overwrite: {
                type: "boolean",
                description: "Set to true to replace an existing file. Default: false.",
              },
            },
            required: ["path", "content"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            try {
              if (typeof params.path !== "string") {
                throw new Error("path must be a string");
              }
              const requestedPath = params.path;

              if (typeof params.content !== "string") {
                throw new Error("content must be a string");
              }
              const content = params.content;
              const overwrite = params.overwrite === true;

              const resolved = validateAccess(
                { allowed_paths: config.allowed_paths, write_paths: writePaths },
                requestedPath,
                "write"
              );

              const buffer = Buffer.from(content, "utf-8");
              if (buffer.byteLength > MAX_FILE_SIZE) {
                throw new Error(
                  `Content too large (${buffer.byteLength} bytes). Maximum: ${MAX_FILE_SIZE} bytes.`
                );
              }

              let mode: "create" | "overwrite";
              let previousContentHash: string | undefined;

              if (overwrite) {
                try {
                  const existing = await readFile(resolved);
                  previousContentHash = createHash("sha256").update(existing).digest("hex");
                  mode = "overwrite";
                } catch (err) {
                  if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
                  mode = "create";
                }
                await writeFile(resolved, buffer);
              } else {
                try {
                  const fh = await open(resolved, "wx");
                  try {
                    await fh.writeFile(buffer);
                  } finally {
                    await fh.close();
                  }
                  mode = "create";
                } catch (err) {
                  if ((err as NodeJS.ErrnoException).code === "EEXIST") {
                    return {
                      isError: true,
                      content: [
                        {
                          type: "text",
                          text: `File already exists at ${requestedPath}. Set overwrite=true to replace.`,
                        },
                      ],
                      // Set details so the audit endpoint suppresses raw params
                      // (which include the full content blob — PII protection).
                      details: {
                        path: relativizeWritePath(resolved, writePaths),
                        mode: "create",
                        overwrite: false,
                        error: "File already exists",
                      },
                    };
                  }
                  throw err;
                }
              }

              const contentHash = createHash("sha256").update(buffer).digest("hex");

              return {
                content: [
                  {
                    type: "text",
                    text: `Wrote ${buffer.byteLength} bytes to ${requestedPath} (mode: ${mode}).`,
                  },
                ],
                details: {
                  path: relativizeWritePath(resolved, writePaths),
                  mode,
                  sizeBytes: buffer.byteLength,
                  contentHash,
                  ...(previousContentHash !== undefined ? { previousContentHash } : {}),
                  overwrite,
                },
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown error";
              // Set details on every error path so the audit endpoint suppresses
              // raw params (notably params.content — PII protection).
              const safePath = typeof params.path === "string" ? params.path : undefined;
              return {
                isError: true,
                content: [{ type: "text", text: message }],
                details: {
                  ...(safePath !== undefined ? { path: safePath } : {}),
                  overwrite: params.overwrite === true,
                  error: message,
                },
              };
            }
          },
        };
      },
      { name: "pinchy_write" }
    );
  },
};

export default plugin;
