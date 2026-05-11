export type McpPresetId =
  | "github"
  | "notion"
  | "linear"
  | "atlassian"
  | "gitlab"
  | "stripe"
  | "cloudflare"
  | "intercom"
  | "highlevel"
  | "generic";

export type McpPreset = {
  id: McpPresetId;
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
    id: "atlassian",
    displayName: "Atlassian",
    defaultUrl: "https://mcp.atlassian.com/v1/mcp",
    defaultTransport: "http",
    toolPrefix: "atlassian_",
    tokenInstructions: `Connects **Jira and Confluence** through Atlassian's MCP server. Your Atlassian org admin must first enable API-token authentication: **Atlassian Administration → \\<org\\> → Rovo → Rovo MCP server → Authentication → toggle API token on.**

Then create a token at [id.atlassian.com/manage-profile/security/api-tokens](https://id.atlassian.com/manage-profile/security/api-tokens):

1. Click **Create API token with scopes**.
2. Pick an expiration (1–365 days). Tokens older than Dec 2024 were force-expired.
3. Select the scopes the agent needs, for example:
   - \`read:jira-work\`, \`write:jira-work\` (Jira read+write)
   - \`read:confluence-content.all\`, \`write:confluence-content\` (Confluence read+write)
4. Click **Create** and copy the token immediately.

Paste the token here. One token covers both Jira and Confluence.`,
  },
  {
    id: "gitlab",
    displayName: "GitLab",
    defaultUrl: "https://gitlab.com/api/v4/mcp",
    defaultTransport: "http",
    toolPrefix: "gitlab_",
    tokenInstructions: `Create a **Personal Access Token** at [gitlab.com/-/user_settings/personal_access_tokens](https://gitlab.com/-/user_settings/personal_access_tokens):

1. Click **Add new token**.
2. Set a name, expiration date (max 365 days on GitLab.com), and select the **\`api\`** scope (read+write). Use \`read_api\` for a read-only agent.
3. Click **Create personal access token** and copy the value immediately — it is only shown once.

For a tighter scope, prefer a **Project Access Token** under Project → Settings → Access Tokens — it limits the blast radius to one project.

The token starts with \`glpat-\`. For self-managed GitLab, use the **Custom MCP server** tile and point it at \`https://<your-host>/api/v4/mcp\`.`,
  },
  {
    id: "stripe",
    displayName: "Stripe",
    defaultUrl: "https://mcp.stripe.com",
    defaultTransport: "http",
    toolPrefix: "stripe_",
    tokenInstructions: `Create a **Restricted API key** at [dashboard.stripe.com/apikeys](https://dashboard.stripe.com/apikeys):

1. **Developers → API keys → Create restricted key**.
2. Give it a name (e.g. "Pinchy agent — production").
3. For each resource the agent should touch, choose **Read** or **Write** (e.g. Customers: Write, PaymentIntents: Write, Refunds: Write, Invoices: Read). Leave the rest at **None** — the available MCP tools are auto-scoped to what the key can do.
4. Click **Create key** and copy the value.

Use a test-mode key (\`rk_test_…\`) while evaluating; switch to live (\`rk_live_…\`) for production.`,
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    defaultUrl: "https://mcp.cloudflare.com/mcp",
    defaultTransport: "http",
    toolPrefix: "cloudflare_",
    tokenInstructions: `Create an **API Token** at [dash.cloudflare.com/profile/api-tokens](https://dash.cloudflare.com/profile/api-tokens):

1. Click **Create Token**. Start from a template ("Edit Cloudflare Workers", "Read all resources") or **Create Custom Token**.
2. Under **Permissions**, add at minimum **Account → Account Settings → Read** so the server can auto-detect the account ID. Add per-product Edit/Read permissions for the resources the agent should manage (Workers Scripts, DNS, R2, KV, etc.).
3. Set an optional TTL.
4. **Do not enable Client IP Address Filtering** — the MCP server doesn't support filtered tokens.
5. Click **Continue → Create Token** and copy the value.

Paste the token here.`,
  },
  {
    id: "intercom",
    displayName: "Intercom",
    defaultUrl: "https://mcp.intercom.com/mcp",
    defaultTransport: "http",
    toolPrefix: "intercom_",
    tokenInstructions: `**Note:** the Intercom MCP server currently supports **US-hosted workspaces only**. EU and AU regions are not yet supported.

Create an **Access Token** in the Intercom Developer Hub:

1. Open [app.intercom.com/a/developer-signup](https://app.intercom.com/a/developer-signup) and switch to your workspace.
2. Go to **Your Apps**, click your private app (or create a new one tied to your main workspace).
3. Open the app → **Authentication** tab → set the scopes the agent needs (e.g. Read conversations, Write conversations, Read and write articles, Read and write tickets).
4. Copy the **Access Token** shown at the top of the page.

Paste the token here. Intercom access tokens do not expire — revoke by deleting the app.`,
  },
  {
    id: "highlevel",
    displayName: "HighLevel",
    defaultUrl: "https://services.leadconnectorhq.com/mcp/",
    defaultTransport: "http",
    toolPrefix: "ghl_",
    tokenInstructions: `Create a **Private Integration Token** in the Sub-Account (Location) the agent should operate in:

1. In HighLevel, switch to the target Sub-Account.
2. **Settings → Private Integrations → Create New Integration**.
3. Select scopes. For a marketing/CRM agent the typical minimum is: View Locations, View+Edit Contacts, View+Edit Conversations, View+Edit Conversation Messages, View+Edit Opportunities, View+Edit Calendars, View+Edit Tags, View Custom Fields, View Pipelines.
4. Click **Create** and copy the token (starts with \`pit-\`).

You can create up to 5 Private Integration Tokens per Sub-Account.

Paste the token here.`,
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
