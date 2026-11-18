import type { ComponentType } from "react";
import {
  OdooIcon,
  GoogleIcon,
  MicrosoftIcon,
  BraveIcon,
  GitHubIcon,
  LinearIcon,
  AtlassianIcon,
  StripeIcon,
  CloudflareIcon,
  IntercomIcon,
  HighLevelIcon,
  McpIcon,
  // NotionIcon and GitLabIcon are deliberately NOT imported here — their
  // hosted MCP servers are OAuth-only as of 2026-05, which Phase 1 doesn't
  // support. See issues #339 (Notion via REST plugin) and #340 (GitLab via
  // OAuth / PAT once GitLab Issue #586184 ships) for the planned follow-ups.
} from "./integration-icons";
import { ImapIcon } from "./imap-icon";

export interface IntegrationType {
  id: string;
  name: string;
  description: string;
  icon: ComponentType<{ className?: string }>;
}

/**
 * Available integration types shown in the /settings/integrations/new
 * picker grid. The MCP-backed entries (mcp-*) all funnel through the same
 * backend (a `type: "mcp"` connection with a preset discriminator, see
 * MCP_TYPE_TO_PRESET below) — they surface as first-class cards so users
 * find them by provider, not by transport mechanism.
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
    id: "microsoft",
    name: "Microsoft",
    description: "Connect your Microsoft 365 account to sync email via Outlook.",
    icon: MicrosoftIcon,
  },
  {
    id: "imap",
    name: "IMAP / Other email",
    description: "Connect any mailbox via IMAP and SMTP.",
    icon: ImapIcon,
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
    description:
      "Manage contacts, conversations, and opportunities. Needs a Sub-Account (Location) ID alongside the token.",
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
  "github" | "linear" | "atlassian" | "stripe" | "cloudflare" | "intercom" | "highlevel" | "generic"
> = {
  "mcp-github": "github",
  "mcp-linear": "linear",
  "mcp-atlassian": "atlassian",
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

const MCP_PRESET_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  github: GitHubIcon,
  linear: LinearIcon,
  atlassian: AtlassianIcon,
  stripe: StripeIcon,
  cloudflare: CloudflareIcon,
  intercom: IntercomIcon,
  highlevel: HighLevelIcon,
  generic: McpIcon,
};

const CONNECTION_TYPE_ICONS: Record<string, ComponentType<{ className?: string }>> = {
  odoo: OdooIcon,
  google: GoogleIcon,
  microsoft: MicrosoftIcon,
  imap: ImapIcon,
  "web-search": BraveIcon,
};

/**
 * Resolve the brand icon for a stored integration connection.
 *
 * MCP connections carry their provider in `data.preset` — the card must show
 * the provider's logo (GitHub, Linear, …), never the transport. Unknown
 * types/presets resolve to the neutral McpIcon rather than silently
 * borrowing another vendor's logo.
 */
export function getConnectionIcon(
  type: string,
  preset?: string
): ComponentType<{ className?: string }> {
  if (type === "mcp") {
    return (preset && MCP_PRESET_ICONS[preset]) || McpIcon;
  }
  return CONNECTION_TYPE_ICONS[type] ?? McpIcon;
}
