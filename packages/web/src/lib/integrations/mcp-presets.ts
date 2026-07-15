// Note: `notion` and `gitlab` are deliberately absent — their hosted MCP
// servers are OAuth-only as of 2026-05, which Phase 1 doesn't support. See
// issues #339 (Notion via REST plugin) and #340 (GitLab via OAuth / PAT
// once GitLab Issue #586184 ships) for the planned follow-ups.
export type McpPresetId =
  | "github"
  | "linear"
  | "atlassian"
  | "stripe"
  | "cloudflare"
  | "intercom"
  | "highlevel"
  | "generic";

/** Always-visible callout above the (collapsed) setup guide — region limits,
 *  prerequisites, and other "read this first" gotchas. */
export type McpSetupNote = { variant: "info" | "warning"; text: string };

export type McpPreset = {
  id: McpPresetId;
  displayName: string;
  defaultUrl?: string;
  defaultTransport: "http" | "sse";
  toolPrefix: string;

  // ── Setup guidance ────────────────────────────────────────────────────────
  // Structured so the connect dialog can render with hierarchy instead of a
  // wall of markdown: a primary "create a token" CTA, an optional always-
  // visible note, a collapsed step-by-step guide, and a hint under the field.
  /** Provider page where the user creates the token. Rendered as the primary
   *  CTA button. Omitted for presets whose token lives in-app (e.g. HighLevel). */
  tokenUrl?: string;
  /** CTA button label, e.g. "Create a token on GitHub". */
  tokenUrlLabel?: string;
  /** Small muted line under the CTA (e.g. "Classic and fine-grained both work"). */
  tokenUrlHint?: string;
  /** Always-visible callout for prerequisites / region limits. */
  setupNote?: McpSetupNote;
  /** Markdown walkthrough, collapsed by default under "Step-by-step guide". */
  setupSteps?: string;
  /** Helper text under the token field (token prefix / scope reminder). Markdown. */
  tokenHint?: string;
};

export const MCP_PRESETS: McpPreset[] = [
  {
    id: "github",
    displayName: "GitHub",
    defaultUrl: "https://api.githubcopilot.com/mcp/",
    defaultTransport: "http",
    toolPrefix: "github_",
    tokenUrl: "https://github.com/settings/personal-access-tokens",
    tokenUrlLabel: "Create a token on GitHub",
    tokenUrlHint:
      "Classic and fine-grained tokens both work — fine-grained is recommended for tighter per-repo scopes.",
    setupSteps: `1. Click **Generate new token**.
2. Set an expiration and choose the repositories the agent should access.
3. Under **Repository permissions**, grant:
   - **Contents** → Read-only (to read files and code)
   - **Issues** → Read and write (to create and update issues)
   - **Pull requests** → Read and write (if the agent should manage PRs)
4. Click **Generate token** and paste the value here.`,
    tokenHint: "Starts with \`github_pat_\` (fine-grained) or \`ghp_\` (classic).",
  },
  {
    id: "linear",
    // Linear migrated from /sse to /mcp (Streamable HTTP) in Feb 2026. The
    // old SSE endpoint is deprecated and emits warnings; new connections
    // should use HTTP. See https://linear.app/changelog/2026-02-05-linear-mcp.
    displayName: "Linear",
    defaultUrl: "https://mcp.linear.app/mcp",
    defaultTransport: "http",
    toolPrefix: "linear_",
    tokenUrl: "https://linear.app/settings/api",
    tokenUrlLabel: "Create an API key in Linear",
    setupSteps: `1. Scroll to **Personal API keys** and click **Create key**.
2. Give it a label (e.g. "Pinchy") and click **Create**.
3. Copy the generated key immediately — it is only shown once.`,
    tokenHint: "Linear API keys start with \`lin_api_\`.",
  },
  {
    id: "atlassian",
    displayName: "Atlassian",
    defaultUrl: "https://mcp.atlassian.com/v1/mcp",
    defaultTransport: "http",
    toolPrefix: "atlassian_",
    // IMPORTANT: Atlassian's MCP server accepts \`Authorization: Bearer\` only
    // for service-account API keys. Personal user tokens require Basic auth
    // (email:token base64), which Phase 1 doesn't support. We instruct the
    // admin to provision a service account so the Bearer flow works.
    tokenUrl: "https://id.atlassian.com/manage-profile/security/api-tokens",
    tokenUrlLabel: "Create an API token in Atlassian",
    tokenUrlHint: "Connects Jira and Confluence through one token.",
    setupNote: {
      variant: "warning",
      text: "Two prerequisites, both requiring an Atlassian org admin: (1) **Enable API-token authentication** for the org under Atlassian Administration → org → Rovo → Rovo MCP server → Authentication. (2) Use a **service-account** API key — personal user tokens use Basic auth, which Pinchy doesn't support yet.",
    },
    setupSteps: `Signed in as the service account, on the API tokens page:

1. Click **Create API token with scopes**.
2. Pick an expiration (1–365 days).
3. Select the scopes the agent needs, for example:
   - \`read:jira-work\`, \`write:jira-work\` (Jira read + write)
   - \`read:confluence-content.all\`, \`write:confluence-content\` (Confluence read + write)
4. Click **Create** and copy the API key immediately.`,
    tokenHint: "One key covers both Jira and Confluence.",
  },
  {
    id: "stripe",
    displayName: "Stripe",
    defaultUrl: "https://mcp.stripe.com",
    defaultTransport: "http",
    toolPrefix: "stripe_",
    tokenUrl: "https://dashboard.stripe.com/apikeys",
    tokenUrlLabel: "Create a restricted key in Stripe",
    setupSteps: `1. **Developers → API keys → Create restricted key**.
2. Give it a name (e.g. "Pinchy agent — production").
3. For each resource the agent should touch, choose **Read** or **Write** (e.g. Customers: Write, PaymentIntents: Write, Refunds: Write, Invoices: Read). Leave the rest at **None** — the available MCP tools are auto-scoped to what the key can do.
4. Click **Create key** and copy the value.`,
    tokenHint:
      "Use a test-mode key (\`rk_test_…\`) while evaluating; switch to live (\`rk_live_…\`) for production.",
  },
  {
    id: "cloudflare",
    displayName: "Cloudflare",
    // `?codemode=false` disables Cloudflare's experimental Code Mode, which
    // surfaces a JS sandbox instead of the regular tool list. OpenClaw's MCP
    // client doesn't speak Code Mode, so we opt out at the URL level.
    defaultUrl: "https://mcp.cloudflare.com/mcp?codemode=false",
    defaultTransport: "http",
    toolPrefix: "cloudflare_",
    tokenUrl: "https://dash.cloudflare.com/profile/api-tokens",
    tokenUrlLabel: "Create an API token in Cloudflare",
    setupSteps: `1. Click **Create Token**. Start from a template ("Edit Cloudflare Workers", "Read all resources") or **Create Custom Token**.
2. Under **Permissions**, add at minimum **Account → Account Settings → Read** so the server can auto-detect the account ID. Add per-product Edit/Read permissions for the resources the agent should manage (Workers Scripts, DNS, R2, KV, etc.).
3. Set an optional TTL.
4. **Do not enable Client IP Address Filtering** — the MCP server doesn't support filtered tokens.
5. Click **Continue → Create Token** and copy the value.`,
  },
  {
    id: "intercom",
    displayName: "Intercom",
    defaultUrl: "https://mcp.intercom.com/mcp",
    defaultTransport: "http",
    toolPrefix: "intercom_",
    tokenUrl: "https://app.intercom.com/a/developer-signup",
    tokenUrlLabel: "Open the Intercom Developer Hub",
    setupNote: {
      variant: "warning",
      text: "US-hosted workspaces only — EU and AU regions are not yet supported.",
    },
    setupSteps: `1. Switch to your workspace, then go to **Your Apps** and click your private app (or create a new one tied to your main workspace).
2. Open the app → **Authentication** tab → set the scopes the agent needs (e.g. Read conversations, Write conversations, Read and write articles, Read and write tickets).
3. Copy the **Access Token** shown at the top of the page.`,
    tokenHint: "Access tokens do not expire — revoke by deleting the app.",
  },
  {
    id: "highlevel",
    displayName: "HighLevel",
    defaultUrl: "https://services.leadconnectorhq.com/mcp/",
    defaultTransport: "http",
    toolPrefix: "ghl_",
    // No tokenUrl: the token is created in-app inside the target Sub-Account,
    // not at a fixed external URL — the steps explain the in-app navigation.
    setupNote: {
      variant: "info",
      text: "Create a **Private Integration Token** in the Sub-Account (Location) the agent should operate in. You can create up to 5 per Sub-Account.",
    },
    setupSteps: `1. In HighLevel, switch to the target Sub-Account.
2. **Settings → Private Integrations → Create New Integration**.
3. Select scopes. For a marketing/CRM agent the typical minimum is: View Locations, View + Edit Contacts, View + Edit Conversations, View + Edit Conversation Messages, View + Edit Opportunities, View + Edit Calendars, View + Edit Tags, View Custom Fields, View Pipelines.
4. Click **Create** and copy the token.`,
    tokenHint: "Tokens start with \`pit-\`.",
  },
  {
    id: "generic",
    displayName: "Generic MCP",
    defaultUrl: undefined,
    defaultTransport: "http",
    toolPrefix: "mcp_",
    // No structured guidance: the custom flow already shows URL + token fields
    // with their own labels, so there's nothing provider-specific to explain.
  },
];

export function getMcpPreset(id: string): McpPreset {
  return MCP_PRESETS.find((p) => p.id === id) ?? MCP_PRESETS.find((p) => p.id === "generic")!;
}
