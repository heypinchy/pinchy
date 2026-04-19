import { readdirSync, readFileSync, statSync, realpathSync } from "fs";
import { join, sep, isAbsolute, normalize } from "path";

interface PluginToolContext {
  agentId?: string;
}

interface DocSource {
  id: string;
  label: string;
  path: string;
}

interface AgentSourceConfig {
  sources?: string[];  // source IDs this agent can access; empty array = no access; undefined = no access
}

interface PluginConfig {
  // New multi-source format
  sources?: DocSource[];
  agents: Record<string, AgentSourceConfig>;
  // Legacy single-source format (backwards compat)
  docsPath?: string;
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
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
}

interface DocEntry {
  path: string;
  title: string;
  description: string;
}

function parseFrontmatter(content: string): { title: string; description: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---/);
  let title = "";
  let description = "";
  if (match) {
    const lines = match[1].split("\n");
    for (const line of lines) {
      const kv = line.match(/^(\w+):\s*(.*)$/);
      if (!kv) continue;
      const key = kv[1];
      let value = kv[2].trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      if (key === "title") title = value;
      if (key === "description") description = value;
    }
  }
  return { title, description };
}

function listDocs(root: string): DocEntry[] {
  const results: DocEntry[] = [];

  function walk(dir: string, relBase: string) {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        walk(fullPath, relPath);
      } else if (entry.isFile() && (entry.name.endsWith(".mdx") || entry.name.endsWith(".md"))) {
        try {
          const content = readFileSync(fullPath, "utf-8");
          const { title, description } = parseFrontmatter(content);
          results.push({ path: relPath, title, description });
        } catch {
          // skip unreadable file
        }
      }
    }
  }

  walk(root, "");
  return results;
}

/**
 * Strip MDX-only syntax from a doc file so the agent receives just the
 * semantic content. Saves tokens (often 20-40%) which translates directly
 * into faster prefill on local LLMs during multi-turn tool-use loops.
 *
 * Removed:
 *   - Frontmatter (already exposed via docs_list)
 *   - import statements at the top of the file
 *   - JSX-style component wrapper tags (<Aside>, <Steps>, ...) — inner
 *     text is kept
 *
 * Preserved exactly:
 *   - Headings, paragraphs, lists, tables
 *   - Fenced code blocks (```...```), even if they contain JSX-like syntax
 */
export function preprocessMdx(raw: string): string {
  // 1. Strip frontmatter (--- ... ---) at the very top
  let text = raw.replace(/^---\n[\s\S]*?\n---\n?/, "");

  // 2. Strip import statements at the top of the file (anything before the
  //    first non-import, non-blank line). MDX imports must be at the top.
  const lines = text.split("\n");
  let firstNonImport = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "") continue;
    if (line.startsWith("import ")) continue;
    firstNonImport = i;
    break;
  }
  text = lines.slice(firstNonImport).join("\n");

  // 3. Carve fenced code blocks out before touching JSX so we never strip
  //    angle brackets that are legitimate code samples.
  const codeBlocks: string[] = [];
  text = text.replace(/```[\s\S]*?```/g, (match) => {
    codeBlocks.push(match);
    return `\u0000CODEBLOCK${codeBlocks.length - 1}\u0000`;
  });

  // 4. Strip JSX component tags. Components in MDX start with an uppercase
  //    letter; lowercase tags like <p>, <div> are HTML and we leave them.
  //    Match both opening (with attributes), closing, and self-closing.
  text = text.replace(/<\/?[A-Z][A-Za-z0-9]*\b[^>]*\/?>/g, "");

  // 5. Restore code blocks
  text = text.replace(/\u0000CODEBLOCK(\d+)\u0000/g, (_m, idx) => codeBlocks[Number(idx)]);

  // 6. Collapse runs of blank lines to a single blank line
  text = text.replace(/\n{3,}/g, "\n\n");

  return text.trim() + "\n";
}

function resolveSafe(docsRoot: string, relPath: string): string | null {
  if (!relPath || typeof relPath !== "string") return null;
  if (isAbsolute(relPath)) return null;
  const normalized = normalize(relPath);
  if (normalized.startsWith("..")) return null;
  const resolved = join(docsRoot, normalized);
  const rootWithSep = docsRoot.endsWith(sep) ? docsRoot : docsRoot + sep;
  if (!resolved.startsWith(rootWithSep)) return null;
  // Defense in depth: a symlink inside docsRoot could point outside it.
  // Resolve the real path of both root and target and re-check containment.
  // If the target doesn't exist yet, realpathSync throws — we treat that as
  // "not a path that needs symlink protection" and let the caller's
  // statSync decide the fate.
  try {
    const realRoot = realpathSync(docsRoot);
    const realTarget = realpathSync(resolved);
    const realRootWithSep = realRoot.endsWith(sep) ? realRoot : realRoot + sep;
    if (realTarget !== realRoot && !realTarget.startsWith(realRootWithSep)) {
      return null;
    }
  } catch {
    // ENOENT — file doesn't exist; let the caller produce a not-found error
  }
  return resolved;
}

const plugin = {
  id: "pinchy-docs",
  name: "Pinchy Docs",
  description:
    "On-demand access to documentation for agents — platform docs, integration guides, and best practices.",
  configSchema: {
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "agents" in value &&
        ("docsPath" in value || "sources" in value)
      ) {
        return { ok: true as const, value };
      }
      return {
        ok: false as const,
        errors: ["Missing required keys in config (agents, and either docsPath or sources)"],
      };
    },
  },

  register(api: PluginApi) {
    const config = api.pluginConfig;
    if (!config) return;

    // Normalize legacy single-source config to multi-source
    const sources: DocSource[] = config.sources
      ? config.sources
      : config.docsPath
        ? [{ id: "pinchy", label: "Pinchy Docs", path: config.docsPath }]
        : [];

    if (sources.length === 0) return;

    const { agents } = config;

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        if (!(agentId in agents)) return null;

        return {
          name: "docs_list",
          label: "List Available Documentation",
          description:
            "List all documentation available to you — platform guides, integration best practices, " +
            "and domain-specific how-tos. Returns titles and descriptions grouped by source. " +
            "Use this when you are unsure how to perform a task correctly (e.g., how to book VAT, " +
            "how to create a credit note). Then use docs_read to read the specific document you need. " +
            "This is lightweight — call it whenever you need guidance.",
          parameters: {
            type: "object",
            properties: {},
          },
          async execute() {
            try {
              const agentConfig = agents[agentId];
              const allowedSourceIds = agentConfig?.sources as string[] | undefined;

              const sourceDocs = sources
                .filter((s) => allowedSourceIds?.includes(s.id) ?? false)
                .map((source) => {
                  const files = listDocs(source.path);
                  return {
                    source: source.id,
                    label: source.label,
                    docs: files.map((f) => ({
                      ...f,
                      path: `${source.id}/${f.path}`,
                    })),
                  };
                })
                .filter((s) => s.docs.length > 0);

              return {
                content: [
                  { type: "text", text: JSON.stringify(sourceDocs, null, 2) },
                ],
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return {
                isError: true,
                content: [{ type: "text", text: `Error listing docs: ${message}` }],
              };
            }
          },
        };
      },
      { name: "docs_list" }
    );

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        if (!(agentId in agents)) return null;

        return {
          name: "docs_read",
          label: "Read Documentation",
          description:
            "Read a single documentation page by its path (as shown by docs_list). Returns the file content with frontmatter and MDX syntax stripped. Read one document at a time — only what you need for the current question. Each read consumes conversation context, so be selective.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Path to the doc file in 'sourceId/relative/path.md' format (as shown by docs_list).",
              },
            },
            required: ["path"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const rawPath = params.path as string;

            // Parse "sourceId/relative/path.md" format
            const slashIdx = rawPath.indexOf("/");
            if (slashIdx === -1) {
              return {
                isError: true,
                content: [{ type: "text", text: `Invalid path format: "${rawPath}". Use "sourceId/path/to/file.md".` }],
              };
            }

            const sourceId = rawPath.slice(0, slashIdx);
            const relPath = rawPath.slice(slashIdx + 1);

            // Check agent has access to this source
            const agentConfig = agents[agentId];
            const allowedSourceIds = agentConfig?.sources as string[] | undefined;
            if (!allowedSourceIds?.includes(sourceId)) {
              return {
                isError: true,
                content: [{ type: "text", text: `Access denied: source "${sourceId}" is not available for this agent.` }],
              };
            }

            // Find the source
            const source = sources.find((s) => s.id === sourceId);
            if (!source) {
              return {
                isError: true,
                content: [{ type: "text", text: `Unknown source: "${sourceId}". Use docs_list to see available sources.` }],
              };
            }

            // Existing resolveSafe + read logic, using source.path as root
            const safe = resolveSafe(source.path, relPath);
            if (!safe) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: `Invalid path: ${rawPath}. Path must be a relative path inside the docs directory.`,
                  },
                ],
              };
            }

            try {
              const stat = statSync(safe);
              if (!stat.isFile()) {
                return {
                  isError: true,
                  content: [{ type: "text", text: `Not a file: ${rawPath}` }],
                };
              }
              const raw = readFileSync(safe, "utf-8");
              const content = preprocessMdx(raw);
              return {
                content: [{ type: "text", text: content }],
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return {
                isError: true,
                content: [{ type: "text", text: `File not found: "${rawPath}" (${message}). Use docs_list to see available files.` }],
              };
            }
          },
        };
      },
      { name: "docs_read" }
    );
  },
};

export default plugin;
