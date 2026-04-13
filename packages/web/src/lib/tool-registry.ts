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
  {
    id: "docs_list",
    label: "List Pinchy documentation",
    description: "List Pinchy platform documentation files (Smithers only)",
    category: "safe",
  },
  {
    id: "docs_read",
    label: "Read Pinchy documentation",
    description: "Read a Pinchy platform documentation file (Smithers only)",
    category: "safe",
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
