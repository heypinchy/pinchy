/**
 * pinchy-knowledge — a thin credential-proxy plugin (see AGENTS.md "Pattern
 * B") in front of Pinchy's internal knowledge-base retrieval API. All
 * retrieval logic (hybrid search, path scoping, embeddings) lives in
 * packages/web (POST /api/internal/knowledge/search); this plugin's
 * `knowledge_search` tool does nothing but call that route with the gateway
 * token and format the results for the model. Keeping retrieval out of the
 * plugin means Postgres/pgvector access, RBAC, and audit stay where the rest
 * of Pinchy's governance logic already lives.
 */

interface PluginToolContext {
  agentId?: string;
}

// Presence-only per-agent gating: an entry in `agents` means the agent may
// call knowledge_search. There are no per-agent parameters (unlike
// pinchy-files' allowed_paths or pinchy-web's allowedDomains) because the
// route itself resolves an agent's KB visibility from the SAME
// pinchy-files allowed_paths that already scope its file access (see the
// route's doc comment) — nothing more for this plugin to carry per agent.
interface PluginConfig {
  apiBaseUrl: string;
  gatewayToken: string;
  agents: Record<string, Record<string, never>>;
}

interface PluginLogger {
  warn?: (message: string) => void;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  logger?: PluginLogger;
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

// Mirrors the response shape of POST /api/internal/knowledge/search
// (packages/web/src/app/api/internal/knowledge/search/route.ts). Note there
// is deliberately no `documentId` here — the route's public response only
// exposes chunkId/text/sourcePath/page/docName, so the plugin uses
// `sourcePath` as the per-document identity below.
export interface KnowledgeSearchResult {
  chunkId: string;
  text: string;
  sourcePath: string;
  page: number | null;
  docName: string;
}

export interface DocumentRef {
  id: string;
  name: string;
}

/**
 * Dedupe the unique documents referenced by a set of chunk results into
 * {id, name} refs — the same shape as the route's own `retrieval.query`
 * audit entry (EntityRef), so a reviewer correlating the tool-call audit
 * row (from this plugin's `details`) with the retrieval audit row (from the
 * route) sees comparable document identities. `sourcePath` stands in for
 * the route's internal `documentId`, which is not part of the public
 * response.
 */
export function returnedDocumentIds(results: KnowledgeSearchResult[]): DocumentRef[] {
  const seen = new Map<string, string>();
  for (const result of results) {
    if (!seen.has(result.sourcePath)) {
      seen.set(result.sourcePath, result.docName);
    }
  }
  return Array.from(seen, ([id, name]) => ({ id, name }));
}

/**
 * Render retrieval results as a numbered, citable source list so the model
 * can cite-then-answer against a closed set of ids (the knowledge-base
 * agent template teaches this pattern in its AGENTS.md). Deterministic and
 * unit-tested: the same input always yields the same output string.
 */
export function formatWithCitations(results: KnowledgeSearchResult[]): string {
  if (results.length === 0) {
    return "No matching passages found in the knowledge base.";
  }
  return results
    .map((result, index) => {
      const pageSuffix = result.page != null ? ` (p. ${result.page})` : "";
      return `[${index + 1}] ${result.docName}${pageSuffix}: "${result.text}"`;
    })
    .join("\n\n");
}

function normalizeBaseUrl(url: string): string {
  let end = url.length;
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* "/" */) end--;
  return url.slice(0, end);
}

const plugin = {
  id: "pinchy-knowledge",
  name: "Pinchy Knowledge",
  description:
    "Retrieves knowledge-base passages for agents via Pinchy's internal hybrid-search API.",
  configSchema: {
    validate: (value: unknown) => {
      if (
        value &&
        typeof value === "object" &&
        "apiBaseUrl" in value &&
        "gatewayToken" in value &&
        "agents" in value
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
    const config = api.pluginConfig;
    if (!config?.apiBaseUrl || !config?.gatewayToken) {
      api.logger?.warn?.(
        "[pinchy-knowledge] plugin config is missing apiBaseUrl or gatewayToken"
      );
      return;
    }

    const { gatewayToken, agents: agentConfigs } = config;
    const apiBaseUrl = normalizeBaseUrl(config.apiBaseUrl);

    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        if (!agentConfigs?.[agentId]) return null;

        return {
          name: "knowledge_search",
          label: "Search Knowledge Base",
          description:
            "Search the organization's knowledge base for passages relevant to a question. Returns numbered, citable source snippets — cite them by number in your answer.",
          parameters: {
            type: "object",
            properties: {
              query: {
                type: "string",
                description: "Natural-language search query",
              },
            },
            required: ["query"],
          },
          async execute(_toolCallId: string, params: Record<string, unknown>) {
            const query = typeof params.query === "string" ? params.query.trim() : "";
            if (!query) {
              return {
                isError: true,
                content: [{ type: "text", text: "A search query is required." }],
              };
            }

            try {
              const res = await fetch(`${apiBaseUrl}/api/internal/knowledge/search`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Authorization: `Bearer ${gatewayToken}`,
                },
                body: JSON.stringify({ query, agentId }),
              });

              if (!res.ok) {
                const data = await res.json().catch(() => ({}) as Record<string, unknown>);
                const message =
                  typeof data.error === "string" ? data.error : `HTTP ${res.status}`;
                return {
                  isError: true,
                  content: [
                    { type: "text", text: `Knowledge base search failed: ${message}` },
                  ],
                  // details.error (and ONLY error — no other keys) is set on
                  // every failure path so the audit endpoint's isError-
                  // stripping defense (#404) can't mask the failure, WITHOUT
                  // suppressing raw params: /api/internal/audit/tool-use only
                  // suppresses params when a curated field beyond `error` is
                  // present (see its "curatesNonErrorFields" check), and a
                  // failed call's params are exactly what forensics needs —
                  // see the 2026-06-25 false-success incident referenced
                  // there. Same shape as pinchy-files' write/read error path.
                  details: { error: message },
                };
              }

              const data = (await res.json()) as { results: KnowledgeSearchResult[] };
              const results = Array.isArray(data.results) ? data.results : [];

              return {
                content: [{ type: "text", text: formatWithCitations(results) }],
                details: {
                  toolName: "knowledge_search",
                  returnedDocumentIds: returnedDocumentIds(results),
                },
              };
            } catch (error) {
              const message = error instanceof Error ? error.message : "Unknown error";
              return {
                isError: true,
                content: [{ type: "text", text: `Knowledge base search failed: ${message}` }],
                // error-only details — see the identical comment on the
                // !res.ok branch above.
                details: { error: message },
              };
            }
          },
        };
      },
      { name: "knowledge_search" }
    );
  },
};

export default plugin;
