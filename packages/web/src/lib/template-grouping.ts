import type { TemplateIconName } from "@/lib/template-icons";

export interface TemplateItem {
  id: string;
  name: string;
  description: string;
  requiresDirectories: boolean;
  requiresOdooConnection?: boolean;
  requiresEmailConnection?: boolean;
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
    "requiresDirectories" | "requiresOdooConnection" | "requiresEmailConnection" | "odooAccessLevel"
  >
): AccessBadgeProps | null {
  if (template.requiresEmailConnection) {
    return { label: "Gmail · Read & Draft", variant: "green" };
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
  if (template.requiresDirectories) {
    return { label: "Documents · Read-only", variant: "green" };
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
    "requiresDirectories" | "requiresOdooConnection" | "requiresEmailConnection" | "odooAccessLevel"
  >
): PermissionItem[] {
  if (template.requiresEmailConnection) {
    return [
      { icon: "check", text: "Read emails from connected Gmail account" },
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
  if (template.requiresDirectories) {
    return [
      { icon: "check", text: "Read files in the selected directories" },
      { icon: "cross", text: "Cannot modify or delete files" },
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
  | "email";

const CATEGORY_DEFINITIONS: readonly { id: CategoryId; label: string }[] = [
  { id: "sales-customers", label: "Sales & Customers" },
  { id: "finance-procurement", label: "Finance & Procurement" },
  { id: "hr-recruiting", label: "HR & Recruiting" },
  { id: "operations", label: "Operations" },
  { id: "marketing-web", label: "Marketing & Web" },
  { id: "knowledge-compliance", label: "Knowledge & Compliance" },
  { id: "email", label: "Email" },
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
  "knowledge-base": "knowledge-compliance",
  "contract-analyzer": "knowledge-compliance",
  "proposal-comparator": "knowledge-compliance",
  "compliance-checker": "knowledge-compliance",
  "email-assistant": "email",
  "email-sales-assistant": "email",
  "email-support-assistant": "email",
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
