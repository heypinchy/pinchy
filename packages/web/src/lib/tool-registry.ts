import { getAllPinchyPluginToolNames } from "@/lib/openclaw-config/plugin-manifest-loader";

export interface ToolDefinition {
  id: string;
  label: string;
  description: string;
  category: "safe" | "powerful";
  integration?: string;
  /**
   * Tool is kept for backwards compatibility with agents created before the
   * tool was renamed/split. The permissions UI hides deprecated tools so
   * new agents don't pick them up, but the registry still recognises them
   * as legitimate `allowed_tools` entries.
   */
  deprecated?: true;
}

export const TOOL_REGISTRY: readonly ToolDefinition[] = [
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
    id: "odoo_list_models",
    label: "Odoo: List models",
    description: "List all available Odoo models",
    category: "safe",
    integration: "odoo",
  },
  {
    id: "odoo_describe_model",
    label: "Odoo: Describe model",
    description: "Discover fields and types for a specific Odoo model",
    category: "safe",
    integration: "odoo",
  },
  // Deprecated alias for `odoo_list_models` + `odoo_describe_model`. Kept so
  // that agents created before v0.5.4 (whose AGENTS.md still says
  // "always call odoo_schema first") keep working through the transition.
  // The permissions UI filters this out; we only recognise it as a valid
  // entry in stored `allowed_tools` arrays.
  {
    id: "odoo_schema",
    label: "Odoo: Schema (deprecated)",
    description:
      "Deprecated. Use odoo_list_models or odoo_describe_model. Kept for backwards compatibility with agents created before v0.5.4.",
    category: "safe",
    integration: "odoo",
    deprecated: true,
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
    id: "odoo_schedule_activity",
    label: "Odoo: Schedule activity",
    description:
      "Schedule a follow-up activity (planned to-do) on an Odoo record so it surfaces in activity views",
    category: "powerful",
    integration: "odoo",
  },
  {
    id: "odoo_complete_activity",
    label: "Odoo: Complete activity",
    description:
      "Mark a scheduled activity as done (posts a completion note and clears it from the to-do list)",
    category: "powerful",
    integration: "odoo",
  },
  {
    id: "odoo_reschedule_activity",
    label: "Odoo: Reschedule activity",
    description: "Change a scheduled activity's due date and/or assignee without closing it",
    category: "powerful",
    integration: "odoo",
  },
  {
    id: "odoo_confirm_order",
    label: "Odoo: Confirm sale order",
    description:
      "Confirm a quotation into a sales order (action_confirm — creates deliveries/procurement)",
    category: "powerful",
    integration: "odoo",
  },
  {
    id: "odoo_apply_inventory",
    label: "Odoo: Apply inventory count",
    description: "Post a counted inventory adjustment on a stock.quant (action_apply_inventory)",
    category: "powerful",
    integration: "odoo",
  },
  {
    id: "odoo_validate_picking",
    label: "Odoo: Validate picking",
    description:
      "Validate a stock transfer (button_validate); reports a handoff if Odoo needs a backorder decision",
    category: "powerful",
    integration: "odoo",
  },
  {
    id: "odoo_mark_mo_done",
    label: "Odoo: Mark MO done",
    description:
      "Mark a manufacturing order done (button_mark_done); reports a handoff if Odoo needs a backorder/consumption decision",
    category: "powerful",
    integration: "odoo",
  },
  {
    id: "odoo_set_approval",
    label: "Odoo: Set approval decision",
    description:
      "Approve or refuse an expense report, purchase order, leave request, or approval request via its blessed method",
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
  {
    id: "odoo_attach_file",
    label: "Odoo: Attach file",
    description: "Attach an uploaded file to an existing Odoo record as ir.attachment",
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

  // Workspace write — governed by pinchy-files plugin
  {
    id: "pinchy_write",
    label: "Write files",
    description: "Write files into the agent's workspace (uploads directory)",
    category: "powerful",
  },
];

// OpenClaw built-in (or bundled-plugin) tools Pinchy intentionally keeps
// reachable, on top of the Pinchy plugin tools. Everything NOT in the emitted
// allowlist is denied — so this list is the complete set of non-Pinchy tools an
// agent may use:
//   - memory_search / memory_get: the bundled `memory-core` plugin powers
//     Pinchy's agent-memory feature (see memory-prompt.ts). They are
//     plugin-owned, so they must be allowed by NAME — `group:memory` does NOT
//     match them (verified against OpenClaw 2026.6.8).
//   - pdf / image: read-only vision/document tools that respect
//     `tools.fs.workspaceOnly`. They power chat attachments: the upload hint
//     tells the agent to call them with the workspace path.
//   - session_status: read-only self-status (the baseline `minimal` profile).
// Notably ABSENT (hence denied): image_generate / music_generate /
// video_generate / tts (produce new content — admin-only), the native
// browser/canvas (group:ui), cron, gateway, message, nodes, subagents,
// sessions_*, and raw exec/fs/web.
const INTENDED_BUILTIN_TOOLS = [
  "memory_search",
  "memory_get",
  "pdf",
  "image",
  "session_status",
] as const;

export function getToolById(id: string): ToolDefinition | undefined {
  return TOOL_REGISTRY.find((t) => t.id === id);
}

export function getToolsByCategory(category: "safe" | "powerful"): ToolDefinition[] {
  return TOOL_REGISTRY.filter((t) => t.category === category);
}

/**
 * Return only the tool ids a read-only agent may use: drop everything
 * categorized as `powerful` (write operations, web search/fetch, odoo
 * create/write/delete, email draft/send, workspace writes). Tools with no
 * registry entry — OpenClaw built-ins (`memory_search`, `pdf`, `image`,
 * `session_status`) and unclassified plugin tools — are kept; they are
 * read-only by construction. This is the per-agent read-only guarantee
 * layered on top of the fail-closed `tools.allow` boundary. See issue #571.
 */
export function filterReadOnlyToolIds(toolIds: string[]): string[] {
  return toolIds.filter((id) => getToolById(id)?.category !== "powerful");
}

/**
 * Compute the fail-closed tool allowlist emitted per agent as `tools.allow`.
 *
 * With no `tools.profile` set, OpenClaw treats `allow` as an absolute allowlist
 * (effective = full ∩ allow), so anything not listed here is denied — including
 * built-ins added in future OpenClaw versions. The list is every Pinchy plugin
 * tool (derived from the manifests, so it can't drift) plus the intentionally
 * allowed read-only built-ins.
 *
 * The same superset is emitted for every agent: per-agent tool gating already
 * happens inside each plugin's own config (the plugin only registers the tools
 * that agent is permitted), so listing a tool an agent lacks is a harmless
 * no-match. This allowlist is the OUTER boundary against built-ins.
 */
export function computeAllowedTools(): string[] {
  return [...getAllPinchyPluginToolNames(), ...INTENDED_BUILTIN_TOOLS];
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

const ODOO_READ_TOOLS = [
  "odoo_list_models",
  "odoo_describe_model",
  "odoo_read",
  "odoo_count",
  "odoo_aggregate",
] as const;
const ODOO_WRITE_TOOLS = [
  "odoo_create",
  "odoo_schedule_activity",
  "odoo_complete_activity",
  "odoo_reschedule_activity",
  "odoo_confirm_order",
  "odoo_apply_inventory",
  "odoo_validate_picking",
  "odoo_mark_mo_done",
  "odoo_set_approval",
  "odoo_write",
  "odoo_attach_file",
] as const;
const ODOO_DELETE_TOOLS = ["odoo_delete"] as const;

// Additive Odoo tools introduced after the read-write/full presets shipped.
// Existing agents predate them, so their presence or absence must NOT flip
// preset detection to "custom" (mirrors the deprecated-alias handling in
// `detectOdooAccessLevel`). New agents get them via the preset; old agents
// stay classified by their base read/write/delete tools until re-aligned.
const ODOO_ADDITIVE_TOOLS = new Set<string>([
  "odoo_schedule_activity",
  "odoo_complete_activity",
  "odoo_reschedule_activity",
  "odoo_confirm_order",
  "odoo_apply_inventory",
  "odoo_validate_picking",
  "odoo_mark_mo_done",
  "odoo_set_approval",
]);

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
      return ["odoo_list_models", "odoo_describe_model"];
  }
}

/** Given a set of allowed tool IDs, detect which OdooAccessLevel they correspond to. */
export function detectOdooAccessLevel(allowedToolIds: string[]): OdooAccessLevel {
  // Ignore deprecated odoo_* aliases when matching against presets — they're
  // attached to migrated agents for compat but are not part of any preset.
  // Without this filter, a v0.5.3-era read-only agent that picked up the
  // odoo_schema compat entry would be misclassified as "custom" and the UI
  // would lose its preset selection.
  const deprecatedIds = new Set(
    TOOL_REGISTRY.filter((t) => t.deprecated && t.integration === "odoo").map((t) => t.id)
  );
  // Ignore both deprecated aliases and additive post-preset tools so neither
  // flips an otherwise-matching agent to "custom".
  const ignored = (id: string) => deprecatedIds.has(id) || ODOO_ADDITIVE_TOOLS.has(id);
  const odooIds = allowedToolIds.filter((id) => id.startsWith("odoo_") && !ignored(id));
  const odooSet = new Set(odooIds);

  const presets: [OdooAccessLevel, readonly string[]][] = [
    ["full", getOdooToolsForAccessLevel("full")],
    ["read-write", getOdooToolsForAccessLevel("read-write")],
    ["read-only", getOdooToolsForAccessLevel("read-only")],
  ];

  for (const [level, presetTools] of presets) {
    const tools = presetTools.filter((t) => !ignored(t));
    if (odooSet.size === tools.length && tools.every((t) => odooSet.has(t))) {
      return level;
    }
  }

  return "custom";
}
