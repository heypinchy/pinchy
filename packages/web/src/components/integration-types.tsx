import type { ComponentType } from "react";
import {
  OdooIcon,
  GoogleIcon,
  BraveIcon,
  GitHubIcon,
  NotionIcon,
  LinearIcon,
  AtlassianIcon,
  GitLabIcon,
  StripeIcon,
  CloudflareIcon,
  IntercomIcon,
  HighLevelIcon,
  McpIcon,
} from "./integration-icons";

export interface IntegrationType {
  id: string;
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Available integration types shown in the picker. The MCP-backed entries
 * (mcp-*) all funnel through the same backend (preset discriminator) — they
 * surface as first-class cards so users find them by provider, not by
 * transport mechanism.
 */
export const INTEGRATION_TYPES: IntegrationType[] = [
  {
    id: "odoo",
    name: "Odoo",
    description: "Connect your Odoo ERP to query sales, inventory, and customer data.",
    icon: OdooIcon,
  },
  {
    id: "google",
    name: "Google",
    description: "Connect your Google account to sync email via Gmail.",
    icon: GoogleIcon,
  },
  {
    id: "web-search",
    name: "Web Search (Brave)",
    description: "Search the web and fetch pages via Brave Search API.",
    icon: BraveIcon,
  },
  {
    id: "mcp-github",
    name: "GitHub",
    description: "Manage repos, issues, and PRs through GitHub's MCP server.",
    icon: GitHubIcon,
  },
  {
    id: "mcp-notion",
    name: "Notion",
    description: "Read and update pages and databases in your Notion workspace.",
    icon: NotionIcon,
  },
  {
    id: "mcp-linear",
    name: "Linear",
    description: "Query issues, projects, and teams from your Linear workspace.",
    icon: LinearIcon,
  },
  {
    id: "mcp-atlassian",
    name: "Atlassian",
    description: "Read and update Jira issues and Confluence pages with one Atlassian token.",
    icon: AtlassianIcon,
  },
  {
    id: "mcp-gitlab",
    name: "GitLab",
    description: "Manage GitLab projects, merge requests, and issues.",
    icon: GitLabIcon,
  },
  {
    id: "mcp-stripe",
    name: "Stripe",
    description: "Query customers, payments, and subscriptions with a restricted API key.",
    icon: StripeIcon,
  },
  {
    id: "mcp-cloudflare",
    name: "Cloudflare",
    description: "Manage Workers, DNS, KV, R2, and other Cloudflare resources.",
    icon: CloudflareIcon,
  },
  {
    id: "mcp-intercom",
    name: "Intercom",
    description: "Search conversations and update tickets across your support workspace.",
    icon: IntercomIcon,
  },
  {
    id: "mcp-highlevel",
    name: "HighLevel",
    description: "Manage contacts, conversations, and opportunities in your sub-account.",
    icon: HighLevelIcon,
  },
  {
    id: "mcp-custom",
    name: "Custom MCP server",
    description: "Bring your own MCP-compatible server URL and token.",
    icon: McpIcon,
  },
];

export type IntegrationTypeId = (typeof INTEGRATION_TYPES)[number]["id"];

/**
 * Map an INTEGRATION_TYPES.id like `mcp-github` to the internal preset
 * discriminator used by the backend and the mcp-presets registry.
 */
export const MCP_TYPE_TO_PRESET: Record<
  string,
  | "github"
  | "notion"
  | "linear"
  | "atlassian"
  | "gitlab"
  | "stripe"
  | "cloudflare"
  | "intercom"
  | "highlevel"
  | "generic"
> = {
  "mcp-github": "github",
  "mcp-notion": "notion",
  "mcp-linear": "linear",
  "mcp-atlassian": "atlassian",
  "mcp-gitlab": "gitlab",
  "mcp-stripe": "stripe",
  "mcp-cloudflare": "cloudflare",
  "mcp-intercom": "intercom",
  "mcp-highlevel": "highlevel",
  "mcp-custom": "generic",
};

export function isMcpType(
  type: string | null | undefined
): type is keyof typeof MCP_TYPE_TO_PRESET {
  return typeof type === "string" && type in MCP_TYPE_TO_PRESET;
}
