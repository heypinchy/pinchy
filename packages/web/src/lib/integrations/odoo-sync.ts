import { OdooClient } from "odoo-node";

/**
 * Curated list of common Odoo models organized by category.
 * No ir.model access needed — we probe each via fields_get() which only
 * requires read access on the model itself.
 */

export interface ModelCategory {
  id: string;
  label: string;
  models: Array<{ model: string; name: string }>;
}

export const MODEL_CATEGORIES: ModelCategory[] = [
  {
    id: "sales",
    label: "Sales",
    models: [
      { model: "sale.order", name: "Orders" },
      { model: "sale.order.line", name: "Order Lines" },
      { model: "sale.order.template", name: "Quotation Templates" },
    ],
  },
  {
    id: "purchase",
    label: "Purchase",
    models: [
      { model: "purchase.order", name: "Orders" },
      { model: "purchase.order.line", name: "Order Lines" },
    ],
  },
  {
    id: "inventory",
    label: "Inventory",
    models: [
      { model: "stock.picking", name: "Transfers" },
      { model: "stock.move", name: "Moves" },
      { model: "stock.move.line", name: "Move Lines" },
      { model: "stock.quant", name: "Stock Levels" },
      { model: "stock.lot", name: "Lots/Serial Numbers" },
      { model: "stock.warehouse", name: "Warehouses" },
      { model: "stock.location", name: "Locations" },
    ],
  },
  {
    id: "products",
    label: "Products",
    models: [
      { model: "product.template", name: "Products" },
      { model: "product.product", name: "Variants" },
      { model: "product.category", name: "Categories" },
      { model: "product.pricelist", name: "Pricelists" },
      { model: "product.pricelist.item", name: "Pricelist Rules" },
      { model: "product.supplierinfo", name: "Supplier Prices" },
    ],
  },
  {
    id: "contacts",
    label: "Contacts",
    models: [
      { model: "res.partner", name: "Contacts" },
      { model: "res.company", name: "Companies" },
      { model: "res.country", name: "Countries" },
      { model: "res.country.state", name: "States" },
    ],
  },
  {
    id: "accounting",
    label: "Accounting",
    models: [
      { model: "account.move", name: "Invoices & Entries" },
      { model: "account.move.line", name: "Journal Items" },
      { model: "account.payment", name: "Payments" },
      { model: "account.analytic.account", name: "Analytic Accounts" },
      { model: "account.analytic.line", name: "Analytic Lines" },
      { model: "account.tax", name: "Taxes" },
      { model: "account.journal", name: "Journals" },
    ],
  },
  {
    id: "crm",
    label: "CRM",
    models: [
      { model: "crm.lead", name: "Leads & Opportunities" },
      { model: "crm.stage", name: "Stages" },
      { model: "crm.team", name: "Sales Teams" },
    ],
  },
  {
    id: "hr",
    label: "HR",
    models: [
      { model: "hr.employee", name: "Employees" },
      { model: "hr.department", name: "Departments" },
      { model: "hr.job", name: "Job Positions" },
      { model: "hr.contract", name: "Contracts" },
      { model: "hr.attendance", name: "Attendances" },
      { model: "hr.leave", name: "Time Off" },
      { model: "hr.leave.type", name: "Time Off Types" },
      { model: "hr.leave.allocation", name: "Time Off Allocations" },
      { model: "hr.expense", name: "Expenses" },
      { model: "hr.expense.sheet", name: "Expense Reports" },
      { model: "hr.applicant", name: "Applicants" },
      { model: "hr.recruitment.stage", name: "Recruitment Stages" },
      { model: "hr.recruitment.source", name: "Recruitment Sources" },
    ],
  },
  {
    id: "projects",
    label: "Projects",
    models: [
      { model: "project.project", name: "Projects" },
      { model: "project.task", name: "Tasks" },
      { model: "project.task.type", name: "Task Stages" },
    ],
  },
  {
    id: "manufacturing",
    label: "Manufacturing",
    models: [
      { model: "mrp.production", name: "Manufacturing Orders" },
      { model: "mrp.workorder", name: "Work Orders" },
      { model: "mrp.bom", name: "Bills of Materials" },
      { model: "mrp.bom.line", name: "BoM Components" },
      { model: "mrp.workcenter", name: "Work Centers" },
    ],
  },
  {
    id: "pos",
    label: "Point of Sale",
    models: [
      { model: "pos.order", name: "POS Orders" },
      { model: "pos.order.line", name: "POS Order Lines" },
      { model: "pos.session", name: "POS Sessions" },
      { model: "pos.config", name: "POS Configurations" },
      { model: "pos.payment", name: "POS Payments" },
      { model: "pos.payment.method", name: "POS Payment Methods" },
    ],
  },
  {
    id: "marketing",
    label: "Marketing",
    models: [
      { model: "mailing.mailing", name: "Mass Mailings" },
      { model: "mailing.list", name: "Mailing Lists" },
      { model: "mailing.contact", name: "Mailing Contacts" },
      { model: "mailing.trace", name: "Mailing Traces" },
      { model: "utm.campaign", name: "Campaigns" },
      { model: "utm.source", name: "UTM Sources" },
      { model: "utm.medium", name: "UTM Media" },
    ],
  },
  {
    id: "fleet",
    label: "Fleet",
    models: [
      { model: "fleet.vehicle", name: "Vehicles" },
      { model: "fleet.vehicle.model", name: "Vehicle Models" },
      { model: "fleet.vehicle.log.services", name: "Service Logs" },
      { model: "fleet.vehicle.log.contract", name: "Contract Logs" },
      { model: "fleet.service.type", name: "Service Types" },
    ],
  },
  {
    id: "website",
    label: "Website",
    models: [
      { model: "website", name: "Websites" },
      { model: "website.visitor", name: "Visitors" },
      { model: "website.track", name: "Visitor Tracks" },
    ],
  },
  {
    id: "mail",
    label: "Messaging",
    models: [
      { model: "mail.message", name: "Messages" },
      { model: "mail.activity", name: "Activities" },
      { model: "mail.compose.message", name: "Email Drafts" },
    ],
  },
  {
    id: "helpdesk",
    label: "Helpdesk",
    models: [{ model: "helpdesk.ticket", name: "Tickets" }],
  },
  {
    id: "notes",
    label: "Notes",
    models: [{ model: "note.note", name: "Notes" }],
  },
  {
    id: "files",
    label: "Files & Attachments",
    models: [{ model: "ir.attachment", name: "Attachments" }],
  },
];

/**
 * Given synced schema data, return the labels of categories that have at least one accessible model.
 * Used by the integration card to show a summary.
 */
export function getAccessibleCategoryLabels(
  data: { models?: Array<{ model: string }> } | null
): string[] {
  if (!data?.models) return [];
  const modelNames = new Set(data.models.map((m) => m.model));
  return MODEL_CATEGORIES.filter((cat) => cat.models.some((m) => modelNames.has(m.model))).map(
    (cat) => cat.label
  );
}

/** Flat list of all known models (derived from categories). */
const ALL_KNOWN_MODELS = MODEL_CATEGORIES.flatMap((cat) =>
  cat.models.map((m) => ({ ...m, category: cat.id }))
);

export interface CategorySummary {
  id: string;
  label: string;
  accessible: boolean;
  accessibleModels: string[];
  totalModels: number;
}

export interface OdooSyncResult {
  success: true;
  models: number;
  lastSyncAt: string;
  categories: CategorySummary[];
  data: {
    models: Array<{
      model: string;
      name: string;
      fields: unknown[];
      access: { read: boolean; create: boolean; write: boolean; delete: boolean };
    }>;
    lastSyncAt: string;
  };
}

export interface OdooSyncError {
  success: false;
  error: string;
}

const MAX_CONCURRENCY = 5;
const MAX_RETRIES = 2;

/** Returns true if the error is a permission/access issue (should not retry). */
function isAccessError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("accesserror") ||
    msg.includes("access denied") ||
    msg.includes("not allowed") ||
    msg.includes("permission denied")
  );
}

/** Run async tasks with limited concurrency. */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<T[]> {
  const results: T[] = new Array(tasks.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < tasks.length) {
      const index = nextIndex++;
      results[index] = await tasks[index]();
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, () => worker()));
  return results;
}

/**
 * Fetch schema from an Odoo instance by probing curated models via fields_get().
 * Does NOT require admin/ir.model access — only needs read access on individual models.
 * Models the user cannot access are silently skipped.
 * Retries transient errors (timeouts, rate limits) up to MAX_RETRIES times.
 * Limits concurrency to MAX_CONCURRENCY to avoid overwhelming the server.
 * Does NOT save anything — returns the data for the caller to handle.
 */
export async function fetchOdooSchema(credentials: {
  url: string;
  db: string;
  uid: number;
  apiKey: string;
}): Promise<OdooSyncResult | OdooSyncError> {
  const client = new OdooClient({
    url: credentials.url,
    db: credentials.db,
    uid: credentials.uid,
    apiKey: credentials.apiKey,
  });

  type AccessRights = {
    read: boolean;
    create: boolean;
    write: boolean;
    delete: boolean;
  };

  type ProbeResult = {
    model: string;
    name: string;
    category: string;
    fields: unknown[];
    accessible: boolean;
    access?: AccessRights;
  };

  const tasks = ALL_KNOWN_MODELS.map(({ model, name, category }) => {
    return async (): Promise<ProbeResult> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const fields = await client.fields(model);

          // Check per-operation access rights
          const safeCheck = async (
            op: "read" | "create" | "write" | "unlink"
          ): Promise<boolean> => {
            try {
              return await client.checkAccessRights(model, op);
            } catch {
              return false;
            }
          };

          const [read, create, write, unlink] = await Promise.all([
            safeCheck("read"),
            safeCheck("create"),
            safeCheck("write"),
            safeCheck("unlink"),
          ]);

          const access = { read, create, write, delete: unlink };

          // Skip models without read access
          if (!read) {
            return { model, name, category, fields: [], accessible: false };
          }

          return { model, name, category, fields, accessible: true, access };
        } catch (error) {
          if (isAccessError(error)) {
            return { model, name, category, fields: [], accessible: false };
          }
          if (attempt === MAX_RETRIES) {
            return { model, name, category, fields: [], accessible: false };
          }
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
        }
      }
      return { model, name, category, fields: [], accessible: false };
    };
  });

  const results = await runWithConcurrency(tasks, MAX_CONCURRENCY);

  const accessibleModels = results.filter((r) => r.accessible && r.fields.length > 0);

  if (accessibleModels.length === 0) {
    return {
      success: false,
      error:
        "Could not access any Odoo models. Please ensure the API user has at least " +
        "read access to the modules you want to use (e.g. Sales, Inventory, Contacts).",
    };
  }

  // Build category summary
  const categories: CategorySummary[] = MODEL_CATEGORIES.map((cat) => {
    const catResults = results.filter((r) => r.category === cat.id);
    const accessible = catResults.filter((r) => r.accessible && r.fields.length > 0);
    return {
      id: cat.id,
      label: cat.label,
      accessible: accessible.length > 0,
      accessibleModels: accessible.map((r) => r.name),
      totalModels: cat.models.length,
    };
  });

  const models = accessibleModels.map(({ model, name, fields, access }) => ({
    model,
    name,
    fields,
    access: access!,
  }));
  const lastSyncAt = new Date().toISOString();
  const data = { models, lastSyncAt };

  return { success: true, models: models.length, lastSyncAt, categories, data };
}
