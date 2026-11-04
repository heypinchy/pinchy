import { OdooClient } from "odoo-node";
import { runWithConcurrency } from "@/lib/concurrency";
import { describeOdooError } from "@/lib/integrations/odoo-error";
import { readOdooFields } from "@/lib/integrations/odoo-calls";

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
      { model: "sale.subscription.plan", name: "Subscription Plans" },
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
      { model: "res.users", name: "Users" },
    ],
  },
  {
    id: "accounting",
    label: "Accounting",
    models: [
      { model: "account.move", name: "Invoices & Entries" },
      { model: "account.move.line", name: "Journal Items" },
      { model: "account.payment", name: "Payments" },
      { model: "account.bank.statement.line", name: "Bank Transactions" },
      { model: "account.journal", name: "Journals" },
      { model: "account.account", name: "Accounts" },
      { model: "account.tax", name: "Taxes" },
      { model: "account.fiscal.position", name: "Fiscal Positions" },
      { model: "account.payment.term", name: "Payment Terms" },
      { model: "account.analytic.account", name: "Analytic Accounts" },
      { model: "account.analytic.line", name: "Analytic Lines" },
      { model: "res.currency", name: "Currencies" },
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
    id: "approvals",
    label: "Approvals",
    models: [
      { model: "approval.request", name: "Approval Requests" },
      { model: "approval.category", name: "Approval Categories" },
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
  isAuthError: boolean;
}

const MAX_CONCURRENCY = 5;
const MAX_RETRIES = 2;

/**
 * Returns true if the error is Odoo refusing this user access (should not
 * retry). An HTTP-level error is not: "HTTP 405: Method Not Allowed" is the
 * server refusing the method, whatever words its status line uses.
 */
function isAccessError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (isHttpLevelError(error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("accesserror") ||
    msg.includes("access denied") ||
    msg.includes("not allowed") ||
    msg.includes("permission denied")
  );
}

/**
 * Did any answer arrive? odoo-node's errors say so by shape: Odoo's own
 * JSON-RPC error carries `data` (its `code` is the JSON-RPC one, e.g. 200);
 * an HTTP error, a refused redirect or a non-JSON-RPC body carries the HTTP
 * status in `code` and no `data`; a request that got no answer at all carries
 * `code` 0 — and a bare error from elsewhere carries neither.
 */
function odooAnswered(error: unknown): boolean {
  return isHttpLevelError(error) || (error as { data?: unknown } | null)?.data !== undefined;
}

/** odoo-node's shape for an HTTP-level failure: the status in `code`, no `data`. */
function isHttpLevelError(error: unknown): boolean {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: unknown };
  return typeof code === "number" && code >= 100 && data === undefined;
}

/** odoo-node's shape for no usable answer at all — even one that broke off. */
function isNoAnswerError(error: unknown): boolean {
  const { code, data } = (error ?? {}) as { code?: unknown; data?: unknown };
  return code === 0 && data === undefined;
}

/** How many distinct failure texts a mixed sync failure names. */
const MAX_NAMED_FAILURES = 3;

/** Returns true when retrying the fields_get probe could plausibly succeed. */
function isTransientOdooProbeError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes("etimedout") ||
    msg.includes("timeout") ||
    msg.includes("econnreset") ||
    msg.includes("econnrefused") ||
    msg.includes("econnaborted") ||
    msg.includes("socket hang up") ||
    msg.includes("network") ||
    msg.includes("fetch failed") ||
    msg.includes("failed to access host") ||
    msg.includes("rate limit") ||
    msg.includes("too many requests") ||
    msg.includes("429") ||
    msg.includes("500") ||
    msg.includes("502") ||
    msg.includes("503") ||
    msg.includes("504") ||
    msg.includes("service unavailable") ||
    msg.includes("gateway timeout") ||
    msg.includes("temporarily unavailable")
  );
}

/**
 * Fetch schema from an Odoo instance by probing curated models via fields_get().
 * Does NOT require admin/ir.model access — only needs read access on individual models.
 * Models the user cannot access are silently skipped. When no model is
 * readable and no probe reported an access problem, every probe failed for
 * another reason, and the error says which: "Could not reach Odoo: …" when
 * none got an answer, the shared error when all failed alike (a refused
 * redirect, a proxy error), otherwise the first few distinct failures.
 * Retries transient errors (timeouts, rate limits, 5xx) up to MAX_RETRIES times.
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
    hadAccessError?: boolean;
    /**
     * Why the probe failed, when it failed for a reason other than access.
     * `unreachable`: it ran out of retries without any answer from Odoo.
     */
    failure?: { text: string; unreachable: boolean };
  };

  const tasks = ALL_KNOWN_MODELS.map(({ model, name, category }) => {
    return async (): Promise<ProbeResult> => {
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        try {
          const fields = await readOdooFields(client, model);

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
            // Permanent access denial — flag it so the caller can distinguish
            // auth-related failures (which should mark the integration as
            // auth_failed) from transient errors.
            return { model, name, category, fields: [], accessible: false, hadAccessError: true };
          }
          const transient = isTransientOdooProbeError(error);
          if (!transient || attempt === MAX_RETRIES) {
            // Non-transient, or out of retries — no point in trying again.
            const described = describeOdooError(error);
            const unreachable = isNoAnswerError(error) || (transient && !odooAnswered(error));
            // A status line may come from a proxy in front of Odoo as much as
            // from Odoo; only an error carrying Odoo's `data` is Odoo's own.
            const text =
              !transient || unreachable
                ? described
                : isHttpLevelError(error)
                  ? // A described message that already says what came back
                    // ("Odoo answered with …") needs no second prefix.
                    described.startsWith("HTTP ")
                    ? `The Odoo address answered with an error: ${described}`
                    : described
                  : `Odoo did not answer successfully: ${described}`;
            return {
              model,
              name,
              category,
              fields: [],
              accessible: false,
              failure: { text, unreachable },
            };
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
    const anyAccessError = results.some((r) => r.hadAccessError);
    const failures = results.map((r) => r.failure);
    // Only claim missing read access when a probe actually reported an access
    // problem: Odoo denied it, or granted no read right.
    if (!anyAccessError && failures.every((f) => f !== undefined)) {
      const distinct = [...new Set(failures.map((f) => f!.text))];
      const texts =
        distinct.slice(0, MAX_NAMED_FAILURES).join("; ") +
        (distinct.length > MAX_NAMED_FAILURES ? "; …" : "");
      // Every probe failing to reach Odoo, or failing the same way (a refused
      // redirect, a proxy error), is one failure of the connection.
      const error = failures.every((f) => f!.unreachable)
        ? `Could not reach Odoo: ${texts}`
        : distinct.length === 1
          ? texts
          : `Could not read any Odoo model: ${texts}`;
      return { success: false, error, isAuthError: false };
    }
    return {
      success: false,
      error:
        "Could not access any Odoo models. Please ensure the API user has at least " +
        "read access to the modules you want to use (e.g. Sales, Inventory, Contacts).",
      isAuthError: anyAccessError,
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
