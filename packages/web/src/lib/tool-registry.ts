export interface ToolDefinition {
  id: string;
  label: string;
  description: string;
  category: "safe" | "powerful";
  requiresDirectories?: boolean;
  integration?: string;
}

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
  // Safe tools — sandboxed, admin-configured paths only
  {
    id: "pinchy_ls",
    label: "List approved directories",
    description: "List files in admin-approved directories only",
    category: "safe",
    requiresDirectories: true,
  },
  {
    id: "pinchy_read",
    label: "Read approved files",
    description: "Read files (including PDFs) from approved directories only",
    category: "safe",
    requiresDirectories: true,
  },

  // Note: docs_list / docs_read are NOT listed here. They are provided by the
  // pinchy-docs plugin, which is enabled automatically for personal agents
  // (Smithers) via openclaw-config.ts. They are not admin-configurable per
  // agent — the permission UI would misleadingly suggest otherwise.

  // Web search tools (pinchy-web plugin — independent, no group)
  {
    id: "pinchy_web_search",
    label: "Search the web",
    description: "Search the web via Brave Search",
    category: "powerful",
    integration: "web-search",
  },
  {
    id: "pinchy_web_fetch",
    label: "Fetch web pages",
    description: "Download and read content from web pages",
    category: "powerful",
    integration: "web-search",
  },

  // Odoo integration tools (safe = read-only, powerful = write operations)
  {
    id: "odoo_schema",
    label: "Odoo: Browse schema",
    description: "Discover available Odoo models and their fields",
    category: "safe",
    integration: "odoo",
  },
  {
    id: "odoo_read",
    label: "Odoo: Read data",
    description: "Query records from Odoo with filters and field selection",
    category: "safe",
    integration: "odoo",
  },
  {
    id: "odoo_count",
    label: "Odoo: Count records",
    description: "Count matching records in Odoo without transferring data",
    category: "safe",
    integration: "odoo",
  },
  {
    id: "odoo_aggregate",
    label: "Odoo: Aggregate data",
    description: "Server-side sums, averages, and grouping in Odoo",
    category: "safe",
    integration: "odoo",
  },
  {
    id: "odoo_create",
    label: "Odoo: Create records",
    description: "Create new records in Odoo",
    category: "powerful",
    integration: "odoo",
  },
  {
    id: "odoo_write",
    label: "Odoo: Update records",
    description: "Modify existing records in Odoo",
    category: "powerful",
    integration: "odoo",
  },
  {
    id: "odoo_delete",
    label: "Odoo: Delete records",
    description: "Delete records from Odoo",
    category: "powerful",
    integration: "odoo",
  },

  // Email integration tools
  {
    id: "email_list",
    label: "Email: List messages",
    description: "List emails from connected inbox",
    category: "safe",
    integration: "email",
  },
  {
    id: "email_read",
    label: "Email: Read message",
    description: "Read full email content",
    category: "safe",
    integration: "email",
  },
  {
    id: "email_search",
    label: "Email: Search",
    description: "Search emails with query",
    category: "safe",
    integration: "email",
  },
  {
    id: "email_draft",
    label: "Email: Create draft",
    description: "Create email draft (does not send)",
    category: "powerful",
    integration: "email",
  },
  {
    id: "email_send",
    label: "Email: Send",
    description: "Send email directly",
    category: "powerful",
    integration: "email",
  },
];

const ALL_GROUPS = ["group:runtime", "group:fs", "group:web"] as const;

// `pdf` and `image` are deliberately NOT in this list. They are read-only
// vision/document tools that respect `tools.fs.workspaceOnly`, and they
// power Pinchy's chat-attachment feature: the upload-hint instructs the
// agent to call them with the workspace path. `image_generate` stays denied
// because it produces new content (token cost, output side-effects) and
// belongs behind explicit admin opt-in.
const STANDALONE_DENY = ["image_generate"] as const;

export function getToolById(id: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((t) => t.id === id);
}

export function getToolsByCategory(category: "safe" | "powerful"): ToolDefinition[] {
  return TOOL_REGISTRY.filter((t) => t.category === category);
}

/**
 * Compute which OpenClaw tool groups and standalone tools to deny.
 * Since no Pinchy-managed tool maps to an OpenClaw group or standalone tool,
 * this always returns the full deny list. The parameter is kept for forward
 * compatibility.
 */
export function computeDeniedGroups(_allowedToolIds: string[]): string[] {
  return [...ALL_GROUPS, ...STANDALONE_DENY];
}

// --- Email operation helpers ---

const EMAIL_READ_TOOLS = ["email_list", "email_read", "email_search"] as const;
const EMAIL_DRAFT_TOOLS = ["email_draft"] as const;
const EMAIL_SEND_TOOLS = ["email_send"] as const;

/**
 * Returns the email_* tool IDs that should be enabled for the given
 * semantic operations (e.g. ["read", "draft"]).
 */
export function getEmailToolsForOperations(operations: string[]): string[] {
  const tools: string[] = [];
  const ops = new Set(operations);
  if (ops.has("read")) tools.push(...EMAIL_READ_TOOLS);
  if (ops.has("draft")) tools.push(...EMAIL_DRAFT_TOOLS);
  if (ops.has("send")) tools.push(...EMAIL_SEND_TOOLS);
  return tools;
}

/**
 * Given a set of email_* tool IDs, detect which semantic operations they
 * correspond to. Inverse of getEmailToolsForOperations.
 */
export function detectEmailOperations(allowedToolIds: string[]): string[] {
  const emailIds = new Set(allowedToolIds.filter((id) => id.startsWith("email_")));
  const ops: string[] = [];
  if (EMAIL_READ_TOOLS.some((t) => emailIds.has(t))) ops.push("read");
  if (EMAIL_DRAFT_TOOLS.some((t) => emailIds.has(t))) ops.push("draft");
  if (EMAIL_SEND_TOOLS.some((t) => emailIds.has(t))) ops.push("send");
  return ops;
}

// --- Odoo access level helpers ---

export type OdooAccessLevel = "read-only" | "read-write" | "full" | "custom";

const ODOO_READ_TOOLS = ["odoo_schema", "odoo_read", "odoo_count", "odoo_aggregate"] as const;
const ODOO_WRITE_TOOLS = ["odoo_create", "odoo_write"] as const;
const ODOO_DELETE_TOOLS = ["odoo_delete"] as const;

/** Returns all Odoo tool definitions from the registry. */
export function getOdooTools(): ToolDefinition[] {
  return TOOL_REGISTRY.filter((t) => t.integration === "odoo");
}

/** Returns all email tool definitions from the registry. */
export function getEmailTools(): ToolDefinition[] {
  return TOOL_REGISTRY.filter((t) => t.integration === "email");
}

/** Returns the odoo_* tool IDs that should be enabled for the given access level. */
export function getOdooToolsForAccessLevel(level: OdooAccessLevel): string[] {
  switch (level) {
    case "read-only":
      return [...ODOO_READ_TOOLS];
    case "read-write":
      return [...ODOO_READ_TOOLS, ...ODOO_WRITE_TOOLS];
    case "full":
      return [...ODOO_READ_TOOLS, ...ODOO_WRITE_TOOLS, ...ODOO_DELETE_TOOLS];
    case "custom":
      return ["odoo_schema"];
  }
}

/** Given a set of allowed tool IDs, detect which OdooAccessLevel they correspond to. */
export function detectOdooAccessLevel(allowedToolIds: string[]): OdooAccessLevel {
  const odooIds = allowedToolIds.filter((id) => id.startsWith("odoo_"));
  const odooSet = new Set(odooIds);

  const presets: [OdooAccessLevel, readonly string[]][] = [
    ["full", getOdooToolsForAccessLevel("full")],
    ["read-write", getOdooToolsForAccessLevel("read-write")],
    ["read-only", getOdooToolsForAccessLevel("read-only")],
  ];

  for (const [level, tools] of presets) {
    if (odooSet.size === tools.length && tools.every((t) => odooSet.has(t))) {
      return level;
    }
  }

  return "custom";
}
