import { getMcpPreset, type McpPresetId } from "@/lib/integrations/mcp-presets";
import type { TemplateIconName } from "@/lib/template-icons";

export interface TemplateItem {
  id: string;
  name: string;
  description: string;
  requiresDirectories: boolean;
  requiresOdooConnection?: boolean;
  requiresEmailConnection?: boolean;
  /**
   * MCP preset this template needs an active connection of ("github", …).
   * A preset string rather than a boolean because MCP has many presets —
   * see AgentTemplate.requiresMcpConnection. Drives the access badge and
   * the permission preview, parity with the other `requires*` flags.
   */
  requiresMcpConnection?: McpPresetId | null;
  /**
   * Tool names this template auto-grants at creation time (the template's
   * `recommendedTools`). Feeds the badge count and the permission preview,
   * so the card can state what access the agent gets BEFORE it's created.
   */
  mcpRecommendedTools?: string[];
  /**
   * Template uses `pinchy-web` (public web search + page fetch). No
   * external account or admin-managed credential is required — the plugin
   * pulls its own credentials at runtime. Drives the access badge and the
   * permission preview, parity with the other `requires*` flags.
   */
  requiresWeb?: boolean;
  odooAccessLevel?: string;
  defaultTagline: string | null;
  available?: boolean;
  unavailableReason?: "no-connection" | "missing-modules" | null;
  disabled?: boolean;
  disabledReason?: string;
  iconName?: TemplateIconName;
}

// --- Access badge helpers ---

export interface AccessBadgeProps {
  label: string;
  variant: "green" | "amber" | "red";
}

export function getAccessBadgeProps(
  template: Pick<
    TemplateItem,
    | "requiresDirectories"
    | "requiresOdooConnection"
    | "requiresEmailConnection"
    | "requiresMcpConnection"
    | "mcpRecommendedTools"
    | "requiresWeb"
    | "odooAccessLevel"
  >
): AccessBadgeProps | null {
  if (template.requiresEmailConnection) {
    return { label: "Email · Read & Draft", variant: "green" };
  }
  if (template.requiresOdooConnection) {
    switch (template.odooAccessLevel) {
      case "read-write":
        return { label: "Odoo · Read & Write", variant: "amber" };
      case "full":
        return { label: "Odoo · Full Access", variant: "red" };
      default:
        return { label: "Odoo · Read-only", variant: "green" };
    }
  }
  if (template.requiresMcpConnection) {
    // Amber, deliberately — NOT green. Unlike email ("Read & Draft") or Odoo
    // ("Read-only"), MCP tools are third-party surface with no read/write
    // classification we can derive: the tool list comes from the provider's
    // server and its real reach is bounded by the admin's token scope, which
    // Pinchy can't see. Green would claim a harmlessness we haven't verified.
    // Amber states the honest thing — this agent can act in an external
    // system — without faking a precision we don't have.
    //
    // NOTE: `amber` is currently also Odoo's "read-write" marker, so the
    // variant is overloaded across two different meanings. That is invisible
    // today because `variant` is never actually rendered — template-selector
    // .tsx paints every badge with the same muted style and uses `label`
    // only. If variant ever becomes a real colour, split these semantics
    // rather than letting MCP silently inherit "read-write".
    const count = template.mcpRecommendedTools?.length ?? 0;
    return {
      label: `${getMcpPreset(template.requiresMcpConnection).displayName} · ${count} ${count === 1 ? "tool" : "tools"}`,
      variant: "amber",
    };
  }
  if (template.requiresDirectories) {
    return { label: "Documents · Read-only", variant: "green" };
  }
  if (template.requiresWeb) {
    return { label: "Web · Public search", variant: "green" };
  }
  return null;
}

// --- Permission preview helpers ---

export interface PermissionItem {
  icon: "check" | "cross" | "warning";
  text: string;
}

export function getPermissionPreviewItems(
  template: Pick<
    TemplateItem,
    | "requiresDirectories"
    | "requiresOdooConnection"
    | "requiresEmailConnection"
    | "requiresMcpConnection"
    | "mcpRecommendedTools"
    | "requiresWeb"
    | "odooAccessLevel"
  >
): PermissionItem[] {
  if (template.requiresEmailConnection) {
    return [
      { icon: "check", text: "Read emails from the connected mailbox" },
      { icon: "check", text: "Create draft emails" },
      { icon: "cross", text: "Cannot send emails directly" },
    ];
  }
  if (template.requiresOdooConnection) {
    switch (template.odooAccessLevel) {
      case "full":
        return [
          { icon: "check", text: "Full access to Odoo data" },
          { icon: "warning", text: "This agent has full access including record deletion" },
        ];
      case "read-write":
        return [
          { icon: "check", text: "Read and write data in Odoo" },
          { icon: "warning", text: "This agent can modify data in Odoo" },
        ];
      default:
        return [
          { icon: "check", text: "Read data from Odoo" },
          { icon: "cross", text: "Cannot create, modify, or delete records" },
        ];
    }
  }
  if (template.requiresMcpConnection) {
    const { displayName } = getMcpPreset(template.requiresMcpConnection);
    const tools = template.mcpRecommendedTools ?? [];
    const items: PermissionItem[] = [];
    // Name the exact tools: these are what POST /api/agents auto-grants, and
    // the preview is where detail is wanted (the badge stays a summary).
    if (tools.length > 0) {
      items.push({ icon: "check", text: `Use these ${displayName} tools: ${tools.join(", ")}` });
    }
    items.push({ icon: "warning", text: `This agent can act in ${displayName} on your behalf` });
    // No "Cannot ..." line on purpose — the agent's real reach is bounded by
    // the admin's MCP token scope, which Pinchy doesn't know. Every other
    // branch's `cross` item states a limit we actually enforce; inventing one
    // here would be a promise we can't keep.
    return items;
  }
  if (template.requiresDirectories) {
    return [
      { icon: "check", text: "Read files in the selected directories" },
      { icon: "cross", text: "Cannot modify or delete files" },
    ];
  }
  if (template.requiresWeb) {
    return [
      { icon: "check", text: "Search the public web" },
      { icon: "check", text: "Fetch public web pages" },
      { icon: "cross", text: "Cannot access your private data or internal systems" },
    ];
  }
  return [];
}

// --- Thematic grouping ---

export type CategoryId =
  | "sales-customers"
  | "finance-procurement"
  | "hr-recruiting"
  | "operations"
  | "marketing-web"
  | "knowledge-compliance"
  | "email"
  | "developer-tools";

const CATEGORY_DEFINITIONS: readonly { id: CategoryId; label: string }[] = [
  { id: "sales-customers", label: "Sales & Customers" },
  { id: "finance-procurement", label: "Finance & Procurement" },
  { id: "hr-recruiting", label: "HR & Recruiting" },
  { id: "operations", label: "Operations" },
  { id: "marketing-web", label: "Marketing & Web" },
  { id: "knowledge-compliance", label: "Knowledge & Compliance" },
  { id: "email", label: "Email" },
  { id: "developer-tools", label: "Developer Tools" },
];

const TEMPLATE_CATEGORY_MAP: Record<string, CategoryId> = {
  "odoo-sales-analyst": "sales-customers",
  "odoo-crm-assistant": "sales-customers",
  "odoo-customer-service": "sales-customers",
  "odoo-subscription-manager": "sales-customers",
  "odoo-pos-analyst": "sales-customers",
  "odoo-finance-controller": "finance-procurement",
  "odoo-bookkeeper": "finance-procurement",
  "odoo-expense-auditor": "finance-procurement",
  "odoo-procurement-agent": "finance-procurement",
  "odoo-approval-manager": "finance-procurement",
  "resume-screener": "hr-recruiting",
  "odoo-recruitment-coordinator": "hr-recruiting",
  "odoo-hr-analyst": "hr-recruiting",
  "odoo-hr-operator": "hr-recruiting",
  "onboarding-guide": "hr-recruiting",
  "odoo-inventory-scout": "operations",
  "odoo-warehouse-operator": "operations",
  "odoo-manufacturing-planner": "operations",
  "odoo-production-operator": "operations",
  "odoo-fleet-manager": "operations",
  "odoo-project-tracker": "operations",
  "odoo-project-manager": "operations",
  "odoo-marketing-analyst": "marketing-web",
  "odoo-website-analyst": "marketing-web",
  "market-monitor": "marketing-web",
  "knowledge-base": "knowledge-compliance",
  "contract-analyzer": "knowledge-compliance",
  "proposal-comparator": "knowledge-compliance",
  "compliance-checker": "knowledge-compliance",
  "email-assistant": "email",
  "email-sales-assistant": "email",
  "email-support-assistant": "email",
  "github-pr-reviewer": "developer-tools",
  "linear-triage": "developer-tools",
};

export interface TemplateCategory {
  id: CategoryId;
  label: string;
  templates: TemplateItem[];
}

export interface CategorizedTemplates {
  categories: TemplateCategory[];
  custom: TemplateItem | null;
}

export function groupTemplatesByCategory(templates: TemplateItem[]): CategorizedTemplates {
  let custom: TemplateItem | null = null;
  const buckets = new Map<CategoryId, TemplateItem[]>();

  for (const template of templates) {
    if (template.id === "custom") {
      custom = template;
      continue;
    }
    const categoryId = TEMPLATE_CATEGORY_MAP[template.id];
    if (!categoryId) continue;

    let bucket = buckets.get(categoryId);
    if (!bucket) {
      bucket = [];
      buckets.set(categoryId, bucket);
    }
    bucket.push(template);
  }

  const categories: TemplateCategory[] = [];
  for (const def of CATEGORY_DEFINITIONS) {
    const items = buckets.get(def.id);
    if (!items || items.length === 0) continue;

    items.sort((a, b) => {
      const aAvail = a.available !== false ? 1 : 0;
      const bAvail = b.available !== false ? 1 : 0;
      return bAvail - aAvail;
    });

    categories.push({ id: def.id, label: def.label, templates: items });
  }

  return { categories, custom };
}
