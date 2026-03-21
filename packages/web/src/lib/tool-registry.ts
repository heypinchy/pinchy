export interface ToolDefinition {
  id: string;
  label: string;
  description: string;
  category: "safe" | "powerful";
  group?: string;
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

  // Powerful tools — unrestricted access
  {
    id: "shell",
    label: "Run shell commands",
    description: "Execute any command on the server",
    category: "powerful",
    group: "group:runtime",
  },
  {
    id: "fs_read",
    label: "Read any file",
    description: "Read any file on the server, ignoring directory restrictions",
    category: "powerful",
    group: "group:fs",
  },
  {
    id: "fs_write",
    label: "Write any file",
    description: "Create and modify any file on the server",
    category: "powerful",
    group: "group:fs",
  },
  {
    id: "pdf",
    label: "Read any PDF",
    description: "Read and analyze any PDF on the server with built-in vision",
    category: "powerful",
  },
  {
    id: "image",
    label: "Analyze any image",
    description: "Analyze any image file on the server using vision",
    category: "powerful",
  },
  {
    id: "image_generate",
    label: "Generate images",
    description: "Create images using AI image generation",
    category: "powerful",
  },
  {
    id: "web_fetch",
    label: "Fetch web pages",
    description: "Download and read content from URLs",
    category: "powerful",
    group: "group:web",
  },
  {
    id: "web_search",
    label: "Search the web",
    description: "Run web searches and read results",
    category: "powerful",
    group: "group:web",
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
