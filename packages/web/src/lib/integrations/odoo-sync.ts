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
    models: Array<{ model: string; name: string; fields: unknown[] }>;
    lastSyncAt: string;
  };
}

export interface OdooSyncError {
  success: false;
  error: string;
}

/**
 * Fetch schema from an Odoo instance by probing curated models via fields_get().
 * Does NOT require admin/ir.model access — only needs read access on individual models.
 * Models the user cannot access are silently skipped.
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

  // Probe each known model via fields_get() — skip models without access
  const results = await Promise.all(
    ALL_KNOWN_MODELS.map(async ({ model, name, category }) => {
      try {
        const fields = await client.fields(model);
        return { model, name, category, fields, accessible: true };
      } catch {
        return { model, name, category, fields: [] as unknown[], accessible: false };
      }
    })
  );

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

  const models = accessibleModels.map(({ model, name, fields }) => ({ model, name, fields }));
  const lastSyncAt = new Date().toISOString();
  const data = { models, lastSyncAt };

  return { success: true, models: models.length, lastSyncAt, categories, data };
}
