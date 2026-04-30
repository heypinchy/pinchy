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

  // Pipedrive integration tools (safe = read-only, powerful = write operations)
  {
    id: "pipedrive_schema",
    label: "Pipedrive: Browse schema",
    description: "Discover available Pipedrive entities and their fields",
    category: "safe",
    integration: "pipedrive",
  },
  {
    id: "pipedrive_read",
    label: "Pipedrive: Read data",
    description: "Query records from Pipedrive with filters",
    category: "safe",
    integration: "pipedrive",
  },
  {
    id: "pipedrive_search",
    label: "Pipedrive: Search",
    description: "Global search across all Pipedrive entities",
    category: "safe",
    integration: "pipedrive",
  },
  {
    id: "pipedrive_summary",
    label: "Pipedrive: Summary & stats",
    description: "Deal summaries, pipeline statistics, and conversion rates",
    category: "safe",
    integration: "pipedrive",
  },
  {
    id: "pipedrive_create",
    label: "Pipedrive: Create records",
    description: "Create new records in Pipedrive",
    category: "powerful",
    integration: "pipedrive",
  },
  {
    id: "pipedrive_update",
    label: "Pipedrive: Update records",
    description: "Modify existing records in Pipedrive",
    category: "powerful",
    integration: "pipedrive",
  },
  {
    id: "pipedrive_delete",
    label: "Pipedrive: Delete records",
    description: "Delete records from Pipedrive",
    category: "powerful",
    integration: "pipedrive",
  },
  {
    id: "pipedrive_merge",
    label: "Pipedrive: Merge duplicates",
    description: "Merge duplicate deals, persons, or organizations",
    category: "powerful",
    integration: "pipedrive",
  },
  {
    id: "pipedrive_relate",
    label: "Pipedrive: Manage relationships",
    description: "Add products to deals, manage participants and followers",
    category: "powerful",
    integration: "pipedrive",
  },
  {
    id: "pipedrive_convert",
    label: "Pipedrive: Convert records",
    description: "Convert leads to deals and vice versa",
    category: "powerful",
    integration: "pipedrive",
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

// Standalone OpenClaw tools that bypass Pinchy's access control and must be
// denied unless an admin explicitly enables them. These tools have global
// file/media access without respecting allowed_paths.
const STANDALONE_DENY = ["pdf", "image", "image_generate"] as const;

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

// --- Pipedrive access level helpers ---

export type PipedriveAccessLevel = "read-only" | "read-write" | "full" | "custom";

const PIPEDRIVE_READ_TOOLS = [
  "pipedrive_schema",
  "pipedrive_read",
  "pipedrive_search",
  "pipedrive_summary",
] as const;
const PIPEDRIVE_WRITE_TOOLS = [
  "pipedrive_create",
  "pipedrive_update",
  "pipedrive_relate",
  "pipedrive_convert",
] as const;
const PIPEDRIVE_DELETE_TOOLS = ["pipedrive_delete", "pipedrive_merge"] as const;

/** Returns all Pipedrive tool definitions from the registry. */
export function getPipedriveTools(): ToolDefinition[] {
  return TOOL_REGISTRY.filter((t) => t.integration === "pipedrive");
}

/** Returns the pipedrive_* tool IDs that should be enabled for the given access level. */
export function getPipedriveToolsForAccessLevel(level: PipedriveAccessLevel): string[] {
  switch (level) {
    case "read-only":
      return [...PIPEDRIVE_READ_TOOLS];
    case "read-write":
      return [...PIPEDRIVE_READ_TOOLS, ...PIPEDRIVE_WRITE_TOOLS];
    case "full":
      return [...PIPEDRIVE_READ_TOOLS, ...PIPEDRIVE_WRITE_TOOLS, ...PIPEDRIVE_DELETE_TOOLS];
    case "custom":
      return ["pipedrive_schema"];
  }
}

/** Given a set of allowed tool IDs, detect which PipedriveAccessLevel they correspond to. */
export function detectPipedriveAccessLevel(allowedToolIds: string[]): PipedriveAccessLevel {
  const pipedriveIds = allowedToolIds.filter((id) => id.startsWith("pipedrive_"));
  const pipedriveSet = new Set(pipedriveIds);

  const presets: [PipedriveAccessLevel, readonly string[]][] = [
    ["full", getPipedriveToolsForAccessLevel("full")],
    ["read-write", getPipedriveToolsForAccessLevel("read-write")],
    ["read-only", getPipedriveToolsForAccessLevel("read-only")],
  ];

  for (const [level, tools] of presets) {
    if (pipedriveSet.size === tools.length && tools.every((t) => pipedriveSet.has(t))) {
      return level;
    }
  }

  return "custom";
}
