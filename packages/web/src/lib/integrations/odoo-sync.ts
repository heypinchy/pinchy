import { OdooClient } from "odoo-node";

/**
 * Curated list of common Odoo models with human-readable names.
 * No ir.model access needed — we probe each via fields_get() which only
 * requires read access on the model itself.
 */
const KNOWN_MODELS: Array<{ model: string; name: string }> = [
  // Sales
  { model: "sale.order", name: "Sales Order" },
  { model: "sale.order.line", name: "Sales Order Line" },
  { model: "sale.order.template", name: "Quotation Template" },
  // Purchase
  { model: "purchase.order", name: "Purchase Order" },
  { model: "purchase.order.line", name: "Purchase Order Line" },
  // Inventory
  { model: "stock.picking", name: "Transfer" },
  { model: "stock.move", name: "Stock Move" },
  { model: "stock.move.line", name: "Stock Move Line" },
  { model: "stock.quant", name: "Stock Quant" },
  { model: "stock.lot", name: "Lot/Serial Number" },
  { model: "stock.warehouse", name: "Warehouse" },
  { model: "stock.location", name: "Location" },
  // Products
  { model: "product.template", name: "Product Template" },
  { model: "product.product", name: "Product Variant" },
  { model: "product.category", name: "Product Category" },
  { model: "product.pricelist", name: "Pricelist" },
  { model: "product.pricelist.item", name: "Pricelist Item" },
  { model: "product.supplierinfo", name: "Supplier Pricelist" },
  // Contacts
  { model: "res.partner", name: "Contact" },
  { model: "res.company", name: "Company" },
  { model: "res.country", name: "Country" },
  { model: "res.country.state", name: "State" },
  // Accounting
  { model: "account.move", name: "Journal Entry" },
  { model: "account.move.line", name: "Journal Item" },
  { model: "account.payment", name: "Payment" },
  { model: "account.analytic.account", name: "Analytic Account" },
  { model: "account.analytic.line", name: "Analytic Line" },
  // CRM
  { model: "crm.lead", name: "Lead/Opportunity" },
  { model: "crm.stage", name: "CRM Stage" },
  { model: "crm.team", name: "Sales Team" },
  // HR
  { model: "hr.employee", name: "Employee" },
  { model: "hr.department", name: "Department" },
  // Mail
  { model: "mail.message", name: "Message" },
  { model: "mail.activity", name: "Activity" },
  { model: "mail.compose.message", name: "Email Composition" },
  // Helpdesk
  { model: "helpdesk.ticket", name: "Helpdesk Ticket" },
  // Notes
  { model: "note.note", name: "Note" },
];

export interface OdooSyncResult {
  success: true;
  models: number;
  lastSyncAt: string;
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
    KNOWN_MODELS.map(async ({ model, name }) => {
      try {
        const fields = await client.fields(model);
        return { model, name, fields };
      } catch {
        // No access or model doesn't exist on this instance — skip
        return null;
      }
    })
  );

  const models = results.filter(
    (r): r is { model: string; name: string; fields: unknown[] } =>
      r !== null && r.fields.length > 0
  );

  if (models.length === 0) {
    return {
      success: false,
      error:
        "Could not access any Odoo models. Please ensure the API user has at least " +
        "read access to the modules you want to use (e.g. Sales, Inventory, Contacts).",
    };
  }

  const lastSyncAt = new Date().toISOString();
  const data = { models, lastSyncAt };

  return { success: true, models: models.length, lastSyncAt, data };
}
