export type McpTool = {
  name: string;
  description?: string;
  inputSchema: Record<string, unknown>;
};

export type McpIntegrationData = {
  type: "mcp";
  preset: "github" | "notion" | "linear" | "generic";
  transport: "http" | "sse";
  url: string;
  tools: McpTool[];
  lastSyncedAt: string; // ISO 8601
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
