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
  pluginConfig?: {
    braveApiKey?: string;
    agents?: Record<string, AgentWebConfig>;
  };
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

interface AgentWebConfig {
  tools: string[];
  allowedDomains?: string[];
  excludedDomains?: string[];
  language?: string;
  country?: string;
  freshness?: string;
}

const plugin = {
  id: "pinchy-web",
  name: "Pinchy Web",
  description: "Web search and page fetching with domain filtering.",

  register(api: PluginApi) {
    const config = api.pluginConfig;
    const braveApiKey = config?.braveApiKey;
    const agentConfigs = config?.agents ?? {};

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
            if (!braveApiKey) {
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
              const searchConfig: BraveSearchConfig = {
                apiKey: braveApiKey,
                allowedDomains: agentConfig.allowedDomains,
                excludedDomains: agentConfig.excludedDomains,
                language: agentConfig.language,
                country: agentConfig.country,
                freshness: agentConfig.freshness,
              };
              const result = await braveSearch(
                params.query as string,
                searchConfig,
              );
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
