import { readFileSync, readdirSync, statSync, realpathSync } from "fs";
import { readFile } from "fs/promises";
import { createHash } from "crypto";
import { join } from "path";
import { validateAccess, MAX_FILE_SIZE, MAX_PDF_FILE_SIZE, type AgentFileConfig } from "./validate";
import { extractPdfText } from "./pdf-extract";
import { formatPdfResult } from "./pdf-format";
import { PdfCache } from "./pdf-cache";
import { createVisionConfig, type VisionApiConfig } from "./pdf-vision-api";
import { runVisionTasks, type AggregatedVisionUsage } from "./pdf-vision-runner";

interface PluginToolContext {
  agentId?: string;
}

interface ContentBlock {
  type: string;
  text: string;
}

interface PluginApi {
  pluginConfig?: {
    agents?: Record<string, AgentFileConfig>;
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

              const stats = statSync(realPath);
              const isPdf = realPath.toLowerCase().endsWith(".pdf");
              const sizeLimit = isPdf ? MAX_PDF_FILE_SIZE : MAX_FILE_SIZE;
              if (stats.size > sizeLimit) {
                return {
                  isError: true,
                  content: [
                    {
                      type: "text",
                      text: `File too large (${stats.size} bytes). Maximum: ${sizeLimit} bytes.`,
                    },
                  ],
                };
              }

              // PDF detection
              if (isPdf) {
                // Build vision config from runtime APIs
                let visionConfig: VisionApiConfig | null = null;
                if (modelAuth && loadConfig) {
                  const cfg = loadConfig();
                  const agents = (cfg as any)?.agents?.list as Array<{ id: string; model: string }> | undefined;
                  const agentModel = agents?.find(
                    (a) => a.id === agentId
                  )?.model;
                  if (agentModel) {
                    visionConfig = createVisionConfig({
                      modelAuth,
                      cfg,
                      model: agentModel,
                    });
                  }
                }
                const pdfResult = await readPdf(realPath, stats, visionConfig);
                // visionUsage is captured here so Task 8 can report it to
                // Pinchy's internal usage endpoint. Return only content
                // to the OpenClaw tool runner.
                void pdfResult.visionUsage;
                return { content: pdfResult.content };
              }

              // Non-PDF: existing behavior
              const content = readFileSync(realPath, "utf-8");
              return { content: [{ type: "text", text: content }] };
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
  },
};

export default plugin;
