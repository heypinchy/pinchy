export type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpIntegrationData = {
  type: "mcp";
  preset:
    | "github"
    | "linear"
    | "atlassian"
    | "stripe"
    | "cloudflare"
    | "intercom"
    | "highlevel"
    | "generic";
  transport: "http" | "sse";
  url: string;
  tools: McpTool[];
  lastSyncAt: string; // ISO 8601
  // Per-connection metadata (NOT a secret) emitted into pinchy-mcp's plugin
  // config and read by the plugin to set extra request headers. Today only
  // HighLevel uses this (`locationId` Sub-Account ID, required header
  // alongside Authorization: Bearer pit-…). Generic shape so future presets
  // can extend without another schema change.
  extraHeaders?: Record<string, string>;
};

export type IntegrationData = McpIntegrationData;

export interface IntegrationConnection {
  id: string;
  type: string;
  name: string;
  description: string;
  credentials:
    | {
        url: string;
        db: string;
        login: string;
      }
    | string
    | null;
  data: {
    lastSyncAt?: string;
    models?: Array<{ model: string; name: string }>;
    categories?: unknown[];
    emailAddress?: string;
    provider?: string;
    connectedAt?: string;
  } | null;
  status: "active" | "pending" | "auth_failed";
  lastError: string | null;
  lastErrorAt: string | null;
  createdAt: string;
  updatedAt: string;
  cannotDecrypt: boolean;
}
