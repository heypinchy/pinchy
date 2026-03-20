export interface ToolDefinition {
  id: string;
  label: string;
  description: string;
  category: "safe" | "powerful";
  group?: string;
  requiresDirectories?: boolean;
}

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
  // Safe tools — sandboxed, admin-configured paths
  {
    id: "pinchy_ls",
    label: "List approved directories",
    description: "List files in directories the admin has approved",
    category: "safe",
    requiresDirectories: true,
  },
  {
    id: "pinchy_read",
    label: "Read approved files",
    description: "Read file contents from approved directories only",
    category: "safe",
    requiresDirectories: true,
  },

  // Powerful tools — direct server access
  {
    id: "shell",
    label: "Run commands",
    description: "Execute shell commands on the server",
    category: "powerful",
    group: "group:runtime",
  },
  {
    id: "fs_read",
    label: "Read any file",
    description: "Read any file on the system, without restrictions",
    category: "powerful",
    group: "group:fs",
  },
  {
    id: "fs_write",
    label: "Write files",
    description: "Create and modify files on the system",
    category: "powerful",
    group: "group:fs",
  },
  {
    id: "web_fetch",
    label: "Browse the web",
    description: "Fetch web pages",
    category: "powerful",
    group: "group:web",
  },
  {
    id: "web_search",
    label: "Search the web",
    description: "Perform web searches",
    category: "powerful",
    group: "group:web",
  },

  // Standalone tools — global access, no sandboxing
  {
    id: "pdf",
    label: "Read any PDF",
    description: "Read and analyze any PDF on the system, without restrictions",
    category: "powerful",
  },
  {
    id: "image",
    label: "Analyze any image",
    description: "Analyze any image on the system using the AI model's vision",
    category: "powerful",
  },
  {
    id: "image_generate",
    label: "Generate images",
    description: "Generate images using AI image generation models",
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
 * Given a list of allowed tool IDs, compute which OpenClaw tool groups and
 * standalone tools to deny.
 * Any group that has at least one allowed tool is NOT denied.
 * Safe tools (pinchy_*) are ignored — they're managed via the plugin system.
 * Standalone tools (e.g. `pdf`) are always denied since Pinchy manages them
 * through its own plugin system with proper access control.
 */
export function computeDeniedGroups(allowedToolIds: string[]): string[] {
  const allowedGroups = new Set<string>();

  for (const toolId of allowedToolIds) {
    const tool = getToolById(toolId);
    if (tool?.group) {
      allowedGroups.add(tool.group);
    }
  }

  const denied: string[] = ALL_GROUPS.filter((g) => !allowedGroups.has(g));

  // Always deny standalone tools that Pinchy replaces with its own implementation
  for (const tool of STANDALONE_DENY) {
    if (!allowedToolIds.includes(tool)) {
      denied.push(tool);
    }
  }

  return denied;
}
