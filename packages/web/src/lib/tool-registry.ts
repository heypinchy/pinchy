export interface ToolDefinition {
  id: string;
  label: string;
  description: string;
  category: "safe" | "powerful";
  requiresDirectories?: boolean;
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

  // Odoo integration tools (safe = read-only, powerful = write operations)
  {
    id: "odoo_schema",
    label: "Odoo: Browse schema",
    description: "Discover available Odoo models and their fields",
    category: "safe",
  },
  {
    id: "odoo_read",
    label: "Odoo: Read data",
    description: "Query records from Odoo with filters and field selection",
    category: "safe",
  },
  {
    id: "odoo_count",
    label: "Odoo: Count records",
    description: "Count matching records in Odoo without transferring data",
    category: "safe",
  },
  {
    id: "odoo_aggregate",
    label: "Odoo: Aggregate data",
    description: "Server-side sums, averages, and grouping in Odoo",
    category: "safe",
  },
  {
    id: "odoo_create",
    label: "Odoo: Create records",
    description: "Create new records in Odoo",
    category: "powerful",
  },
  {
    id: "odoo_write",
    label: "Odoo: Update records",
    description: "Modify existing records in Odoo",
    category: "powerful",
  },
  {
    id: "odoo_delete",
    label: "Odoo: Delete records",
    description: "Delete records from Odoo",
    category: "powerful",
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
