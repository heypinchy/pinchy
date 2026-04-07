import { readdirSync, readFileSync, statSync } from "fs";
import { join, sep, isAbsolute, normalize } from "path";

interface PluginToolContext {
  agentId?: string;
}

interface PluginConfig {
  docsPath: string;
  agents: Record<string, Record<string, unknown>>;
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

function listMdxFiles(root: string): DocEntry[] {
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
      } else if (entry.isFile() && entry.name.endsWith(".mdx")) {
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
  if (normalized.startsWith("..") || normalized.split(sep).includes("..")) return null;
  const resolved = join(docsRoot, normalized);
  const rootWithSep = docsRoot.endsWith(sep) ? docsRoot : docsRoot + sep;
  if (!resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

const plugin = {
  id: "pinchy-docs",
  name: "Pinchy Docs",
  description:
    "On-demand access to Pinchy platform documentation for personal assistants.",
  configSchema: {
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "docsPath" in value &&
        "agents" in value
      ) {
        return { ok: true as const, value };
      }
      return {
        ok: false as const,
        errors: ["Missing required keys in config (docsPath, agents)"],
      };
    },
  },

  register(api: PluginApi) {
    const config = api.pluginConfig;
    if (!config) return;

    const { docsPath, agents } = config;

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        if (!(agentId in agents)) return null;

        return {
          name: "docs_list",
          label: "List Pinchy Documentation",
          description:
            "List all available Pinchy platform documentation files. Returns a JSON array with the path, title, and description of each doc page. Use this first to discover what docs exist, then read specific files with docs_read.",
          parameters: {
            type: "object",
            properties: {},
          },
          async execute() {
            try {
              const files = listMdxFiles(docsPath);
              return {
                content: [
                  { type: "text", text: JSON.stringify(files, null, 2) },
                ],
              };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return {
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
          label: "Read Pinchy Documentation",
          description:
            "Read a single Pinchy platform documentation file by its relative path (as returned by docs_list). Returns the full file content including frontmatter.",
          parameters: {
            type: "object",
            properties: {
              path: {
                type: "string",
                description:
                  "Relative path to the doc file (e.g. 'guides/ollama-setup.mdx')",
              },
            },
            required: ["path"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const relPath = params.path as string;
            const safe = resolveSafe(docsPath, relPath);
            if (!safe) {
              return {
                content: [
                  {
                    type: "text",
                    text: `Invalid path: ${relPath}. Path must be a relative path inside the docs directory.`,
                  },
                ],
              };
            }
            try {
              const stat = statSync(safe);
              if (!stat.isFile()) {
                return {
                  content: [{ type: "text", text: `Not a file: ${relPath}` }],
                };
              }
              const content = readFileSync(safe, "utf-8");
              return { content: [{ type: "text", text: preprocessMdx(content) }] };
            } catch (error) {
              const message =
                error instanceof Error ? error.message : "Unknown error";
              return {
                content: [
                  { type: "text", text: `File not found: ${relPath} (${message})` },
                ],
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
