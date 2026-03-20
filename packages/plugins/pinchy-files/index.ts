import { readFileSync, readdirSync, statSync, realpathSync } from "fs";
import { createHash } from "crypto";
import { join } from "path";
import { validateAccess, MAX_FILE_SIZE, type AgentFileConfig } from "./validate";
import { extractPdfText } from "./pdf-extract";
import { processVisionPages, type DescribeImageFn } from "./pdf-vision";
import { formatPdfResult } from "./pdf-format";
import { PdfCache } from "./pdf-cache";

interface PluginToolContext {
  agentId?: string;
}

interface PluginApi {
  pluginConfig?: {
    agents?: Record<string, AgentFileConfig>;
  };
  runtime?: {
    mediaUnderstanding?: {
      describeImageFile: (opts: {
        filePath: string;
        cfg: unknown;
        agentDir: string;
      }) => Promise<{ text: string }>;
    };
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
  ) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

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
  describeImage: DescribeImageFn | null
): Promise<{ content: Array<{ type: string; text: string }> }> {
  const fileBuffer = readFileSync(realPath);
  const contentHash = createHash("sha256").update(fileBuffer).digest("hex");

  const pdfCache = getCache();
  const cached = pdfCache.get(realPath, stats.size, stats.mtimeMs, contentHash);
  if (cached) {
    return { content: [{ type: "text", text: cached }] };
  }

  const extraction = await extractPdfText(fileBuffer);
  const pagesWithVision = await processVisionPages(extraction.pages, describeImage);
  const formatted = formatPdfResult({ ...extraction, pages: pagesWithVision }, realPath);

  pdfCache.set(realPath, stats.size, stats.mtimeMs, contentHash, formatted);
  return { content: [{ type: "text", text: formatted }] };
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
    const describeImage: DescribeImageFn | null =
      api.runtime?.mediaUnderstanding?.describeImageFile ?? null;

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
                .filter((name) => !name.startsWith("."))
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
              if (stats.size > MAX_FILE_SIZE) {
                return {
                  content: [
                    {
                      type: "text",
                      text: `File too large (${stats.size} bytes). Maximum: ${MAX_FILE_SIZE} bytes.`,
                    },
                  ],
                };
              }

              // PDF detection
              if (realPath.toLowerCase().endsWith(".pdf")) {
                return await readPdf(realPath, stats, describeImage);
              }

              // Non-PDF: existing behavior
              const content = readFileSync(realPath, "utf-8");
              return { content: [{ type: "text", text: content }] };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return {
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
