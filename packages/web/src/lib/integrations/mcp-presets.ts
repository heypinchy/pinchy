export type McpPreset = {
  id: "github" | "notion" | "linear" | "generic";
  displayName: string;
  defaultUrl?: string;
  defaultTransport: "http" | "sse";
  tokenInstructions: string;
  toolPrefix: string;
};

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "github",
    displayName: "GitHub",
    defaultUrl: "https://api.githubcopilot.com/mcp/",
    defaultTransport: "http",
    toolPrefix: "github_",
    tokenInstructions: `Create a **Fine-Grained Personal Access Token** at [github.com/settings/personal-access-tokens](https://github.com/settings/personal-access-tokens):

1. Click **Generate new token**.
2. Set an expiration and choose the repositories the agent should access.
3. Under **Repository permissions**, grant:
   - **Contents** → Read-only (to read files and code)
   - **Issues** → Read and write (to create and update issues)
   - **Pull requests** → Read and write (if the agent should manage PRs)
4. Click **Generate token** and paste the value here.

The token starts with \`github_pat_\`.`,
  },
  {
    id: "notion",
    displayName: "Notion",
    defaultUrl: "https://api.notion.com/mcp/",
    defaultTransport: "http",
    toolPrefix: "notion_",
    tokenInstructions: `Create an **Internal Integration token** at [notion.so/my-integrations](https://www.notion.so/my-integrations):

1. Click **New integration** and give it a name.
2. Select the workspace and set the required **Capabilities** (Read content, Update content, Insert content).
3. Click **Submit** and copy the **Internal Integration Token**.
4. Open each Notion page or database the agent needs access to, click **⋯ → Add connections**, and add your integration.

Paste the token (starts with \`secret_\`) here.`,
  },
  {
    id: "linear",
    displayName: "Linear",
    defaultUrl: "https://mcp.linear.app/sse",
    defaultTransport: "sse",
    toolPrefix: "linear_",
    tokenInstructions: `Create a **Personal API key** at [linear.app/settings/api](https://linear.app/settings/api):

1. Scroll to **Personal API keys** and click **Create key**.
2. Give it a label (e.g. "Pinchy") and click **Create**.
3. Copy the generated key immediately — it is only shown once.

Paste the key here. Linear API keys start with \`lin_api_\`.`,
  },
  {
    id: "generic",
    displayName: "Generic MCP",
    defaultUrl: undefined,
    defaultTransport: "http",
    toolPrefix: "mcp_",
    tokenInstructions: "Enter your MCP server URL and authentication token.",
  },
];

export function getMcpPreset(id: string): McpPreset {
  return MCP_PRESETS.find((p) => p.id === id) ?? MCP_PRESETS.find((p) => p.id === "generic")!;
}
