import { braveSearch, type BraveSearchConfig } from "./brave-search.js";
import { webFetch, type WebFetchConfig } from "./web-fetch.js";

interface PluginToolContext {
  agentId?: string;
}

interface ContentBlock {
  type: string;
  text: string;
}

interface PluginApi {
  pluginConfig?: PluginConfig;
  registerTool: (
    factory: (ctx: PluginToolContext) => AgentTool | null,
    opts?: { name?: string },
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
    signal?: AbortSignal,
  ) => Promise<{ content: ContentBlock[]; isError?: boolean }>;
}

interface PluginConfig {
  apiBaseUrl?: string;
  gatewayToken?: string;
  /** ID of the web-search integration connection in Pinchy. The Brave
   * apiKey is fetched on-demand from Pinchy's internal credentials API
   * — never written into openclaw.json. See #209 for the bug class
   * that prompted this pattern. */
  connectionId?: string;
  agents?: Record<string, AgentWebConfig>;
}

interface AgentWebConfig {
  tools: string[];
  allowedDomains?: string[];
  excludedDomains?: string[];
  language?: string;
  country?: string;
  freshness?: string;
}

interface BraveCredentials {
  apiKey: string;
}

function assertBraveCredentialsShape(creds: unknown): asserts creds is BraveCredentials {
  if (!creds || typeof creds !== "object") {
    throw new Error(`pinchy-web: credentials must be an object, got ${typeof creds}`);
  }
  const obj = creds as Record<string, unknown>;
  const actual = typeof obj.apiKey;
  if (actual !== "string") {
    throw new Error(
      `pinchy-web: credentials.apiKey must be a string, got ${actual}` +
        (actual === "object" ? " (looks like an unresolved SecretRef — see #209)" : ""),
    );
  }
}

async function fetchBraveCredentials(
  apiBaseUrl: string,
  gatewayToken: string,
  connectionId: string,
): Promise<BraveCredentials> {
  const response = await fetch(
    `${apiBaseUrl}/api/internal/integrations/${connectionId}/credentials`,
    { headers: { Authorization: `Bearer ${gatewayToken}` } },
  );
  if (!response.ok) {
    throw new Error(
      `Failed to fetch Brave credentials: HTTP ${response.status} ${response.statusText}`,
    );
  }
  const data = (await response.json()) as { credentials?: unknown };
  assertBraveCredentialsShape(data.credentials);
  return data.credentials;
}

const plugin = {
  id: "pinchy-web",
  name: "Pinchy Web",
  description: "Web search and page fetching with domain filtering.",

  register(api: PluginApi) {
    const config = api.pluginConfig;
    const apiBaseUrl = config?.apiBaseUrl ?? "";
    const gatewayToken = config?.gatewayToken ?? "";
    const connectionId = config?.connectionId ?? "";
    const agentConfigs = config?.agents ?? {};

    // Cached Brave apiKey. Same TTL semantics as pinchy-odoo: fast
    // first-call latency but fresh enough for credential rotation
    // without an OpenClaw restart. On a 401 from Brave we invalidate
    // and retry once.
    const CREDENTIALS_TTL_MS = 5 * 60 * 1000;
    let cached: { apiKey: string; expiresAt: number } | null = null;

    async function getBraveApiKey(): Promise<string> {
      if (cached && cached.expiresAt > Date.now()) return cached.apiKey;
      if (!connectionId || !apiBaseUrl || !gatewayToken) {
        throw new Error(
          "pinchy-web: missing connectionId/apiBaseUrl/gatewayToken in plugin config",
        );
      }
      const creds = await fetchBraveCredentials(apiBaseUrl, gatewayToken, connectionId);
      cached = { apiKey: creds.apiKey, expiresAt: Date.now() + CREDENTIALS_TTL_MS };
      return creds.apiKey;
    }

    function invalidateCache() {
      cached = null;
    }

    async function withAuthRetry<T>(fn: (apiKey: string) => Promise<T>): Promise<T> {
      const apiKey = await getBraveApiKey();
      try {
        return await fn(apiKey);
      } catch (err) {
        const msg = err instanceof Error ? err.message.toLowerCase() : "";
        if (!(msg.includes("401") || msg.includes("unauthor") || msg.includes("invalid api"))) {
          throw err;
        }
        invalidateCache();
        const fresh = await getBraveApiKey();
        return fn(fresh);
      }
    }

    const haveCredentialsConfig = Boolean(connectionId && apiBaseUrl && gatewayToken);

    // pinchy_web_search
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const agentConfig = agentConfigs[agentId];
        if (!agentConfig?.tools?.includes("pinchy_web_search")) return null;

        return {
          name: "pinchy_web_search",
          label: "Web Search",
          description:
            "Search the web using Brave Search. Returns titles, URLs, and snippets for each result.",
          parameters: {
            type: "object",
            properties: {
              query: { type: "string", description: "Search query" },
            },
            required: ["query"],
          },
          async execute(_toolCallId, params) {
            if (!haveCredentialsConfig) {
              return {
                isError: true,
                content: [
                  {
                    type: "text",
                    text: "Web search is not configured. Ask an admin to add a Brave Search API key in Settings \u2192 Integrations.",
                  },
                ],
              };
            }
            try {
              const result = await withAuthRetry((apiKey) => {
                const searchConfig: BraveSearchConfig = {
                  apiKey,
                  allowedDomains: agentConfig.allowedDomains,
                  excludedDomains: agentConfig.excludedDomains,
                  language: agentConfig.language,
                  country: agentConfig.country,
                  freshness: agentConfig.freshness,
                };
                return braveSearch(params.query as string, searchConfig);
              });
              return {
                content: [
                  {
                    type: "text",
                    text: JSON.stringify(result.results, null, 2),
                  },
                ],
              };
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error);
              return {
                isError: true,
                content: [{ type: "text", text: `Search failed: ${msg}` }],
              };
            }
          },
        };
      },
      { name: "pinchy_web_search" },
    );

    // pinchy_web_fetch
    api.registerTool(
      (ctx: PluginToolContext) => {
        const agentId = ctx.agentId;
        if (!agentId) return null;
        const agentConfig = agentConfigs[agentId];
        if (!agentConfig?.tools?.includes("pinchy_web_fetch")) return null;

        return {
          name: "pinchy_web_fetch",
          label: "Fetch Web Page",
          description:
            "Download and read content from a web page URL. Returns extracted text content.",
          parameters: {
            type: "object",
            properties: {
              url: { type: "string", description: "URL to fetch" },
            },
            required: ["url"],
          },
          async execute(_toolCallId, params) {
            try {
              const fetchConfig: WebFetchConfig = {
                allowedDomains: agentConfig.allowedDomains,
                excludedDomains: agentConfig.excludedDomains,
              };
              const result = await webFetch(
                params.url as string,
                fetchConfig,
              );
              return {
                isError: result.isError,
                content: [{ type: "text", text: result.content }],
              };
            } catch (error) {
              const msg =
                error instanceof Error ? error.message : String(error);
              return {
                isError: true,
                content: [{ type: "text", text: `Fetch failed: ${msg}` }],
              };
            }
          },
        };
      },
      { name: "pinchy_web_fetch" },
    );
  },
};

export default plugin;
