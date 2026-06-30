// Mock Odoo JSON-RPC server for E2E testing
// CommonJS, zero dependencies — runs on plain Node.js

const http = require("http");

// ---------------------------------------------------------------------------
// Default auth credentials (configurable via /control/configure)
// ---------------------------------------------------------------------------
let authConfig = {
  db: "testdb",
  login: "admin",
  apiKey: "test-api-key",
  uid: 2,
};

// Auth failure mode — toggled via /control/auth-mode { mode: "ok" | "fail" }
let authMode = "ok";

// ---------------------------------------------------------------------------
// Field schemas per model
// ---------------------------------------------------------------------------
const MODEL_FIELDS = {
  "sale.order": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: {
      string: "Order Reference",
      type: "char",
      required: true,
      readonly: true,
    },
    partner_id: {
      string: "Customer",
      type: "many2one",
      required: true,
      readonly: false,
      relation: "res.partner",
    },
    date_order: {
      string: "Order Date",
      type: "datetime",
      required: true,
      readonly: false,
    },
    amount_total: {
      string: "Total",
      type: "monetary",
      required: false,
      readonly: true,
    },
    state: {
      string: "Status",
      type: "selection",
      required: false,
      readonly: true,
      selection: [
        ["draft", "Quotation"],
        ["sent", "Quotation Sent"],
        ["sale", "Sales Order"],
        ["done", "Locked"],
        ["cancel", "Cancelled"],
      ],
    },
  },
  "res.partner": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: {
      string: "Name",
      type: "char",
      required: true,
      readonly: false,
    },
    email: {
      string: "Email",
      type: "char",
      required: false,
      readonly: false,
    },
    phone: {
      string: "Phone",
      type: "char",
      required: false,
      readonly: false,
    },
    is_company: {
      string: "Is a Company",
      type: "boolean",
      required: false,
      readonly: false,
    },
    zip: { string: "ZIP", type: "char", required: false, readonly: false },
    state_id: {
      string: "State",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "res.country.state",
    },
    country_id: {
      string: "Country",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "res.country",
    },
    // Optional company_id: false means the partner is shared across companies
    // (the Odoo multi-company convention). Present so the plugin's
    // company-scoping (OR-with-false) can be exercised against res.partner.
    company_id: {
      string: "Company",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "res.company",
    },
  },
  "res.country": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: {
      string: "Country Name",
      type: "char",
      required: true,
      readonly: false,
    },
    code: {
      string: "Country Code",
      type: "char",
      required: true,
      readonly: false,
    },
  },
  "product.product": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: {
      string: "Name",
      type: "char",
      required: true,
      readonly: false,
    },
    list_price: {
      string: "Sales Price",
      type: "float",
      required: false,
      readonly: false,
    },
    default_code: {
      string: "Internal Reference",
      type: "char",
      required: false,
      readonly: false,
    },
    categ_id: {
      string: "Product Category",
      type: "many2one",
      required: true,
      readonly: false,
      relation: "product.category",
    },
  },
  "ir.model": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    model: {
      string: "Model",
      type: "char",
      required: true,
      readonly: true,
    },
    name: {
      string: "Model Description",
      type: "char",
      required: true,
      readonly: true,
    },
  },
  // External-id registry. Backs xmlid → record-id resolution (e.g. the
  // canonical "To-Do" activity type `mail.mail_activity_data_todo`).
  "ir.model.data": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    module: { string: "Module", type: "char", required: true, readonly: false },
    name: {
      string: "External Identifier",
      type: "char",
      required: true,
      readonly: false,
    },
    model: { string: "Model", type: "char", required: true, readonly: false },
    res_id: {
      string: "Record ID",
      type: "integer",
      required: false,
      readonly: false,
    },
  },
  "res.users": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: { string: "Name", type: "char", required: true, readonly: false },
    login: { string: "Login", type: "char", required: true, readonly: false },
  },
  "crm.lead": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: {
      string: "Opportunity",
      type: "char",
      required: true,
      readonly: false,
    },
    type: {
      string: "Type",
      type: "selection",
      required: false,
      readonly: false,
      selection: [
        ["lead", "Lead"],
        ["opportunity", "Opportunity"],
      ],
    },
    user_id: {
      string: "Salesperson",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "res.users",
    },
    partner_id: {
      string: "Customer",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "res.partner",
    },
  },
  "mail.activity.type": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: { string: "Name", type: "char", required: true, readonly: false },
    category: {
      string: "Action",
      type: "selection",
      required: false,
      readonly: false,
      selection: [
        ["default", "None"],
        ["upload_file", "Upload Document"],
        ["phonecall", "Phonecall"],
      ],
    },
  },
  // Mirrors Odoo's real mail.activity field contract: `res_model_id` is the
  // required FK to ir.model; `res_model` is a READONLY related char computed
  // from it; `res_id` is a many2one_reference guarded by a SQL CHECK that it
  // is non-null and non-zero. Writing `res_model` directly is a no-op — the
  // exact trap that broke direct mail.activity creation (see create handler).
  "mail.activity": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    res_model_id: {
      string: "Document Model",
      type: "many2one",
      required: true,
      readonly: false,
      relation: "ir.model",
    },
    res_model: {
      string: "Related Document Model",
      type: "char",
      required: false,
      readonly: true,
    },
    res_id: {
      string: "Related Document ID",
      type: "many2one_reference",
      required: false,
      readonly: false,
    },
    activity_type_id: {
      string: "Activity Type",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "mail.activity.type",
    },
    summary: {
      string: "Summary",
      type: "char",
      required: false,
      readonly: false,
    },
    note: { string: "Note", type: "html", required: false, readonly: false },
    date_deadline: {
      string: "Due Date",
      type: "date",
      required: true,
      readonly: false,
    },
    user_id: {
      string: "Assigned to",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "res.users",
    },
    state: {
      string: "State",
      type: "selection",
      required: false,
      readonly: true,
      selection: [
        ["overdue", "Overdue"],
        ["today", "Today"],
        ["planned", "Planned"],
      ],
    },
  },
  // Multi-company accounting models — seeded so the plugin's m2o resolution
  // and the cross-company guard can be exercised end-to-end. Two companies
  // each carry a "Miscellaneous Operations" journal (code SONST), mirroring
  // the production collision that blocked the Penny agent's opening-balance
  // booking: journal codes/names are unique per-company in Odoo, not globally.
  "res.company": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: {
      string: "Name",
      type: "char",
      required: true,
      readonly: false,
    },
  },
  "account.journal": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: {
      string: "Name",
      type: "char",
      required: true,
      readonly: false,
    },
    code: {
      string: "Short Code",
      type: "char",
      required: true,
      readonly: false,
    },
    company_id: {
      string: "Company",
      type: "many2one",
      required: true,
      readonly: false,
      relation: "res.company",
    },
  },
  "account.move": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: { string: "Name", type: "char", required: false, readonly: false },
    ref: { string: "Reference", type: "char", required: false, readonly: false },
    date: { string: "Date", type: "char", required: false, readonly: false },
    move_type: {
      string: "Move Type",
      type: "selection",
      required: false,
      readonly: false,
      selection: [
        ["entry", "Journal Entry"],
        ["out_invoice", "Customer Invoice"],
        ["in_invoice", "Vendor Bill"],
      ],
    },
    journal_id: {
      string: "Journal",
      type: "many2one",
      required: true,
      readonly: false,
      relation: "account.journal",
    },
    company_id: {
      string: "Company",
      type: "many2one",
      required: true,
      readonly: false,
      relation: "res.company",
    },
    partner_id: {
      string: "Partner",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "res.partner",
    },
    line_ids: {
      string: "Journal Items",
      type: "one2many",
      required: false,
      readonly: false,
      relation: "account.move.line",
    },
    invoice_line_ids: {
      string: "Invoice Lines",
      type: "one2many",
      required: false,
      readonly: false,
      relation: "account.move.line",
    },
  },
  // Chart of accounts — company-scoped (optional company_id; false = shared).
  // Seeded with a multi-company name collision mirroring account.journal, so
  // nested account_id name lookups can exercise the OR-with-false scope.
  "account.account": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    code: { string: "Code", type: "char", required: false, readonly: false },
    name: { string: "Name", type: "char", required: false, readonly: false },
    display_name: {
      string: "Display Name",
      type: "char",
      required: false,
      readonly: false,
    },
    account_type: {
      string: "Type",
      type: "char",
      required: false,
      readonly: false,
    },
    company_id: {
      string: "Company",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "res.company",
    },
  },
  // Journal items (the lines of a move). account_id is the m2o whose nested
  // resolution (#615) this model exists to test.
  "account.move.line": {
    id: { string: "ID", type: "integer", required: false, readonly: true },
    name: { string: "Label", type: "char", required: false, readonly: false },
    debit: { string: "Debit", type: "float", required: false, readonly: false },
    credit: { string: "Credit", type: "float", required: false, readonly: false },
    account_id: {
      string: "Account",
      type: "many2one",
      required: true,
      readonly: false,
      relation: "account.account",
    },
    move_id: {
      string: "Move",
      type: "many2one",
      required: true,
      readonly: false,
      relation: "account.move",
    },
    company_id: {
      string: "Company",
      type: "many2one",
      required: false,
      readonly: false,
      relation: "res.company",
    },
  },
};

// ---------------------------------------------------------------------------
// Default seed data
// ---------------------------------------------------------------------------
function getDefaultRecords() {
  return {
    "sale.order": [
      {
        id: 1,
        name: "S00001",
        partner_id: [1, "Müller GmbH"],
        date_order: "2026-03-20 10:00:00",
        amount_total: 2340.0,
        state: "sale",
      },
      {
        id: 2,
        name: "S00002",
        partner_id: [2, "Bauer AG"],
        date_order: "2026-03-21 14:30:00",
        amount_total: 1560.0,
        state: "sale",
      },
      {
        id: 3,
        name: "S00003",
        partner_id: [3, "Schmidt KG"],
        date_order: "2026-03-22 09:15:00",
        amount_total: 890.0,
        state: "draft",
      },
      {
        id: 4,
        name: "S00004",
        partner_id: [1, "Müller GmbH"],
        date_order: "2026-03-23 11:00:00",
        amount_total: 4200.0,
        state: "sale",
      },
      {
        id: 5,
        name: "S00005",
        partner_id: [4, "Weber & Co"],
        date_order: "2026-03-24 08:45:00",
        amount_total: 670.0,
        state: "sent",
      },
    ],
    "res.partner": [
      {
        id: 1,
        name: "Müller GmbH",
        email: "info@mueller.at",
        phone: "+43 1 234567",
        is_company: true,
        zip: "1010",
        state_id: [1, "Wien"],
        country_id: [14, "Austria"],
      },
      {
        id: 2,
        name: "Bauer AG",
        email: "office@bauer.at",
        phone: "+43 316 987654",
        is_company: true,
        zip: "8010",
        state_id: [2, "Steiermark"],
        country_id: [14, "Austria"],
      },
      {
        id: 3,
        name: "Schmidt KG",
        email: "schmidt@schmidt.at",
        phone: "+43 732 456789",
        is_company: true,
        zip: "4020",
        state_id: [3, "Oberösterreich"],
        country_id: [14, "Austria"],
      },
      {
        id: 4,
        name: "Weber & Co",
        email: "weber@weber.at",
        phone: "+43 662 112233",
        is_company: true,
        zip: "5020",
        state_id: [4, "Salzburg"],
        country_id: [14, "Austria"],
      },
      // A SHARED partner (company_id = false) — visible across companies per
      // Odoo's multi-company convention. Used to exercise the OR-with-false
      // scoping: a create with company_id set must still resolve this partner.
      {
        id: 5,
        name: "Shared Vendor",
        email: "shared@vendor.at",
        is_company: true,
        country_id: [14, "Austria"],
        company_id: false,
      },
      {
        id: 6,
        name: "Helmcraft Vendor",
        email: "vendor@helmcraft.at",
        is_company: true,
        country_id: [14, "Austria"],
        company_id: [1, "Helmcraft GmbH"],
      },
    ],
    "res.country": [
      { id: 1, name: "Aruba", code: "AW" },
      { id: 14, name: "Austria", code: "AT" },
      { id: 220, name: "Uganda", code: "UG" },
      { id: 230, name: "Uzbekistan", code: "UZ" },
      { id: 233, name: "United States", code: "US" },
    ],
    "product.product": [
      {
        id: 1,
        name: "Doppelstabmatte 8/6/8 - 2030x2500mm",
        list_price: 45.9,
        default_code: "DSM-2030",
        categ_id: [1, "Gittermatten"],
      },
      {
        id: 2,
        name: "Zaunpfosten 60x40mm - 2200mm",
        list_price: 18.5,
        default_code: "ZP-2200",
        categ_id: [2, "Pfosten"],
      },
      {
        id: 3,
        name: "Befestigungsschellen Set",
        list_price: 3.2,
        default_code: "BS-SET",
        categ_id: [3, "Zubehör"],
      },
    ],
    "ir.model": [
      { id: 1, model: "sale.order", name: "Sales Order" },
      { id: 2, model: "res.partner", name: "Contact" },
      { id: 3, model: "product.product", name: "Product" },
      { id: 4, model: "res.country", name: "Country" },
      { id: 5, model: "crm.lead", name: "Lead/Opportunity" },
      { id: 6, model: "mail.activity", name: "Activity" },
      { id: 7, model: "mail.activity.type", name: "Activity Type" },
      { id: 8, model: "res.users", name: "User" },
      { id: 9, model: "res.company", name: "Company" },
      { id: 10, model: "account.journal", name: "Journal" },
      { id: 11, model: "account.move", name: "Journal Entry" },
      { id: 12, model: "account.account", name: "Account" },
      { id: 13, model: "account.move.line", name: "Journal Item" },
    ],
    "res.users": [
      { id: 2, name: "Mitch Admin", login: "admin" },
      { id: 7, name: "Sally Seller", login: "sally" },
    ],
    "crm.lead": [
      {
        id: 1,
        name: "Big Fence Order — Müller GmbH",
        type: "opportunity",
        user_id: [7, "Sally Seller"],
        partner_id: [1, "Müller GmbH"],
      },
      {
        id: 2,
        name: "Cold inbound — no owner yet",
        type: "lead",
        user_id: false,
        partner_id: false,
      },
    ],
    "mail.activity.type": [
      { id: 1, name: "To-Do", category: "default" },
      { id: 2, name: "Call", category: "phonecall" },
    ],
    // The canonical xmlid for the To-Do activity type, mirroring Odoo's
    // `mail.mail_activity_data_todo`. Lets the plugin resolve the default
    // activity type locale-independently via ir.model.data.
    "ir.model.data": [
      {
        id: 1,
        module: "mail",
        name: "mail_activity_data_todo",
        model: "mail.activity.type",
        res_id: 1,
      },
    ],
    "mail.activity": [],
    "res.company": [
      { id: 1, name: "Helmcraft GmbH" },
      { id: 2, name: "Clemens Helm" },
    ],
    // Two journals share name "Miscellaneous Operations" / code "SONST" — one
    // per company. A free-floating name/code lookup is ambiguous across
    // these; the plugin must scope by company or resolve via the opaque ref.
    "account.journal": [
      {
        id: 17,
        name: "Miscellaneous Operations",
        code: "SONST",
        company_id: [1, "Helmcraft GmbH"],
      },
      {
        id: 24,
        name: "Miscellaneous Operations",
        code: "SONST",
        company_id: [2, "Clemens Helm"],
      },
    ],
    "account.move": [],
    // Multi-company account collision: "Bank" exists in both companies with
    // the same code, plus a shared account (company_id = false). Lets nested
    // account_id name lookups exercise the OR-with-false scope.
    "account.account": [
      {
        id: 42,
        code: "1000",
        name: "Bank",
        display_name: "1000 Bank",
        account_type: "asset_cash",
        company_id: [1, "Helmcraft GmbH"],
      },
      {
        id: 77,
        code: "1000",
        name: "Bank",
        display_name: "1000 Bank",
        account_type: "asset_cash",
        company_id: [2, "Clemens Helm"],
      },
      {
        id: 88,
        code: "9999",
        name: "Opening Balance",
        display_name: "9999 Opening Balance",
        account_type: "equity",
        company_id: false,
      },
    ],
    "account.move.line": [],
  };
}

// In-memory data store. `store` and `nextIds` are keyed by the model name,
// which arrives from the (test-only) JSON-RPC request. They are Maps — not
// plain objects — so a request-supplied model name is never used as an object
// property key, structurally eliminating the remote-property-injection /
// prototype-pollution sink that a `store[model] = …` write would otherwise be.
let store = new Map(Object.entries(getDefaultRecords()));
let nextIds = new Map(); // per-model auto-increment counters
let accessRights = {}; // { "sale.order": { read: true, create: false, ... } }
// Override results for generic record-action method calls, keyed by
// "<model>.<method>" — used to simulate Odoo returning a wizard action.
let methodResponses = {};

function resetNextIds() {
  nextIds = new Map();
  for (const [model, records] of store) {
    const maxId = records.reduce((m, r) => Math.max(m, r.id || 0), 0);
    nextIds.set(model, maxId + 1);
  }
}

function ensureModel(model) {
  if (!store.has(model)) {
    store.set(model, []);
    nextIds.set(model, 1);
  }
}

// ---------------------------------------------------------------------------
// Domain filter evaluation (Odoo Polish notation)
// ---------------------------------------------------------------------------

function evaluateLeaf(record, leaf) {
  const [field, operator, value] = leaf;

  // Handle dotted field access for many2one (e.g. partner_id.name)
  let recordValue;
  if (field.includes(".")) {
    const parts = field.split(".");
    let current = record[parts[0]];
    for (let i = 1; i < parts.length; i++) {
      if (Array.isArray(current)) {
        // many2one [id, name] — .name → index 1, .id → index 0
        current = parts[i] === "id" ? current[0] : current[1];
      } else if (current && typeof current === "object") {
        current = current[parts[i]];
      } else {
        current = undefined;
        break;
      }
    }
    recordValue = current;
  } else {
    recordValue = record[field];
    // For many2one fields stored as [id, name], compare against id by default
    if (Array.isArray(recordValue) && recordValue.length === 2) {
      if (typeof value === "number" || typeof value === "boolean") {
        recordValue = recordValue[0];
      } else if (typeof value === "string") {
        recordValue = recordValue[1];
      }
    }
  }

  switch (operator) {
    case "=":
      return recordValue === value || (value === false && recordValue == null);
    case "!=":
      return recordValue !== value && !(value === false && recordValue == null);
    case ">":
      return recordValue > value;
    case ">=":
      return recordValue >= value;
    case "<":
      return recordValue < value;
    case "<=":
      return recordValue <= value;
    case "in":
      return Array.isArray(value) && value.includes(recordValue);
    case "not in":
      return !Array.isArray(value) || !value.includes(recordValue);
    case "like":
      return typeof recordValue === "string" && recordValue.includes(value);
    case "ilike":
      return (
        typeof recordValue === "string" &&
        recordValue.toLowerCase().includes(String(value).toLowerCase())
      );
    default:
      return true;
  }
}

function evaluateDomain(records, domain) {
  if (!domain || domain.length === 0) return records;

  return records.filter((record) => {
    // Parse Polish notation domain
    const stack = [];
    // Process from right to left for Polish notation
    for (let i = domain.length - 1; i >= 0; i--) {
      const element = domain[i];
      if (Array.isArray(element)) {
        stack.push(evaluateLeaf(record, element));
      } else if (element === "&") {
        const a = stack.pop();
        const b = stack.pop();
        stack.push(a && b);
      } else if (element === "|") {
        const a = stack.pop();
        const b = stack.pop();
        stack.push(a || b);
      } else if (element === "!") {
        const a = stack.pop();
        stack.push(!a);
      }
    }

    // If stack has multiple values left, implicit AND between all of them
    if (stack.length === 0) return true;
    if (stack.length === 1) return stack[0];
    return stack.every(Boolean);
  });
}

// ---------------------------------------------------------------------------
// Helper: pick fields from record
// ---------------------------------------------------------------------------
function pickFields(record, fields) {
  if (!fields || fields.length === 0) return { ...record };
  const result = { id: record.id };
  for (const f of fields) {
    if (f in record) result[f] = record[f];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helper: sort records by order string e.g. "date_order desc, id asc"
// ---------------------------------------------------------------------------
function sortRecords(records, orderStr) {
  if (!orderStr) return records;
  const parts = orderStr.split(",").map((s) => {
    const tokens = s.trim().split(/\s+/);
    return {
      field: tokens[0],
      desc: (tokens[1] || "asc").toLowerCase() === "desc",
    };
  });
  return [...records].sort((a, b) => {
    for (const { field, desc } of parts) {
      let va = a[field];
      let vb = b[field];
      if (va == null && vb == null) continue;
      if (va == null) return desc ? 1 : -1;
      if (vb == null) return desc ? -1 : 1;
      if (va < vb) return desc ? 1 : -1;
      if (va > vb) return desc ? -1 : 1;
    }
    return 0;
  });
}

// ---------------------------------------------------------------------------
// one2many command-tuple processing + m2o type validation (issue #615)
// ---------------------------------------------------------------------------

// Validate that m2o field values are Odoo-legal: false/null, a positive
// integer id, or [int, name]. A bare string (e.g. an undecoded
// `pinchy_ref:v1:…` token the agent copied into `line_ids[].account_id`) is
// rejected the way real Odoo rejects it — reproducing the #615 audit-mystery:
// without the plugin's nested ref-decoding, the create fails at the Odoo
// layer (the plugin's audit `success` flag reflects Odoo acceptance, so a
// rejection surfaces as `failure`). Returns a __jsonrpc_error object on
// violation, else null.
function validateM2oFields(model, values) {
  const fields = MODEL_FIELDS[model] || {};
  for (const [name, def] of Object.entries(fields)) {
    if (def.type !== "many2one") continue;
    if (!(name in values)) continue;
    const v = values[name];
    if (v === false || v == null) continue;
    if (typeof v === "number" && Number.isInteger(v) && v > 0) continue;
    if (
      Array.isArray(v) &&
      v.length === 2 &&
      typeof v[0] === "number" &&
      typeof v[1] === "string"
    ) {
      continue;
    }
    return {
      __jsonrpc_error: true,
      message: `Invalid value for many2one field "${name}" on ${model}: expected a positive integer id, [id, name], or false (got ${JSON.stringify(v)}).`,
    };
  }
  return null;
}

// Find the inverse many2one field on a line model that points back at the
// parent model (e.g. account.move.line.move_id → account.move), so created
// child records carry the back-link the way Odoo sets it.
function findInverseField(lineModel, parentModel) {
  const fields = MODEL_FIELDS[lineModel] || {};
  for (const [name, def] of Object.entries(fields)) {
    if (def.type === "many2one" && def.relation === parentModel) return name;
  }
  return null;
}

// Materialize one2many command tuples into child records, mirroring Odoo's
// create-with-lines semantics. Returns the resolved list of child ids for the
// parent's field, OR a __jsonrpc_error object if a nested m2o value is
// invalid. Codes: 0 create, 1 update, 2 delete, 3 unlink, 4 link, 5 clear,
// 6 replace. Only 0/1 carry a values dict.
function processOne2ManyTuples(model, fieldName, relation, tuples, parentId) {
  const ids = [];
  for (const tuple of tuples) {
    if (!Array.isArray(tuple) || typeof tuple[0] !== "number") continue;
    const code = tuple[0];
    if (code === 0) {
      const lineValues = { ...(tuple[2] || {}) };
      const inverse = findInverseField(relation, model);
      if (inverse) lineValues[inverse] = [parentId, ""];
      const err = validateM2oFields(relation, lineValues);
      if (err) return err;
      const lineId = nextIds.get(relation) || 1;
      nextIds.set(relation, lineId + 1);
      store.get(relation).push({ id: lineId, ...lineValues });
      ids.push(lineId);
    } else if (code === 1) {
      const lineId = tuple[1];
      const rec = (store.get(relation) || []).find((r) => r.id === lineId);
      if (rec) Object.assign(rec, tuple[2] || {});
      ids.push(lineId);
    } else if (code === 4) {
      ids.push(tuple[1]);
    } else if (code === 6) {
      ids.push(...(tuple[2] || []));
    }
    // 2 (delete), 3 (unlink), 5 (clear) — no ids added on a fresh create.
  }
  return ids;
}

// ---------------------------------------------------------------------------
// JSON-RPC handler
// ---------------------------------------------------------------------------
function handleJsonRpc(body) {
  const { method, params } = body;

  if (method === "call") {
    const service = params.service;
    const svcMethod = params.method;

    // common/version
    if (service === "common" && svcMethod === "version") {
      return {
        server_version: "17.0",
        server_version_info: [17, 0, 0, "final", 0],
        server_serie: "17.0",
        protocol_version: 1,
      };
    }

    // common/authenticate
    if (service === "common" && svcMethod === "authenticate") {
      if (authMode === "fail") {
        return false;
      }
      const [db, login, apiKey] = params.args || [];
      if (
        db === authConfig.db &&
        login === authConfig.login &&
        apiKey === authConfig.apiKey
      ) {
        return authConfig.uid;
      }
      return false;
    }

    // object/execute_kw
    if (service === "object" && svcMethod === "execute_kw") {
      if (authMode === "fail") {
        return {
          __jsonrpc_error: true,
          message: "access denied: invalid credentials",
        };
      }
      const args = params.args || [];
      // args: [db, uid, apiKey, model, method, positionalArgs, kwArgs]
      const model = args[3];
      const objMethod = args[4];
      const positionalArgs = args[5] || [];
      const kwArgs = args[6] || {};

      ensureModel(model);
      const allRecords = store.get(model);

      // search_read
      if (objMethod === "search_read") {
        const domain = positionalArgs[0] || [];
        const { fields, limit, offset, order } = kwArgs;
        let filtered = evaluateDomain(allRecords, domain);
        filtered = sortRecords(filtered, order);
        const start = offset || 0;
        const end = limit ? start + limit : filtered.length;
        const sliced = filtered.slice(start, end);
        return sliced.map((r) => pickFields(r, fields));
      }

      // search_count
      if (objMethod === "search_count") {
        const domain = positionalArgs[0] || [];
        return evaluateDomain(allRecords, domain).length;
      }

      // read_group
      if (objMethod === "read_group") {
        const domain = positionalArgs[0] || [];
        const { fields: groupFields, groupby, limit, offset } = kwArgs;
        const filtered = evaluateDomain(allRecords, domain);
        const groupByField = Array.isArray(groupby) ? groupby[0] : groupby;

        const groups = {};
        for (const record of filtered) {
          let key = record[groupByField];
          // For many2one, use the display name
          if (Array.isArray(key)) key = key[1];
          if (key == null) key = false;
          const groupKey = String(key);
          if (!groups[groupKey]) {
            groups[groupKey] = { records: [], rawKey: record[groupByField] };
          }
          groups[groupKey].records.push(record);
        }

        let results = Object.entries(groups).map(
          ([key, { records, rawKey }]) => {
            const result = {};
            result[groupByField] = rawKey;
            result[groupByField + "_count"] = records.length;
            result["__count"] = records.length;

            // Sum numeric fields if requested
            if (groupFields) {
              for (const f of groupFields) {
                const fieldName = f.includes(":") ? f.split(":")[0] : f;
                if (fieldName === groupByField) continue;
                const fieldSchema =
                  MODEL_FIELDS[model] && MODEL_FIELDS[model][fieldName];
                if (
                  fieldSchema &&
                  (fieldSchema.type === "float" ||
                    fieldSchema.type === "monetary" ||
                    fieldSchema.type === "integer")
                ) {
                  result[fieldName] = records.reduce(
                    (sum, r) => sum + (r[fieldName] || 0),
                    0,
                  );
                }
              }
            }

            result["__domain"] = [[groupByField, "=", rawKey]];
            return result;
          },
        );

        const start = offset || 0;
        const end = limit ? start + limit : results.length;
        return results.slice(start, end);
      }

      // fields_get
      if (objMethod === "fields_get") {
        const schema = MODEL_FIELDS[model] || {};
        const attributes = kwArgs.attributes;
        if (!attributes) return schema;
        // Filter to requested attributes
        const result = {};
        for (const [fname, fdef] of Object.entries(schema)) {
          result[fname] = {};
          for (const attr of attributes) {
            if (attr in fdef) result[fname][attr] = fdef[attr];
          }
        }
        return result;
      }

      // create
      if (objMethod === "create") {
        const values = { ...(positionalArgs[0] || {}) };

        // mail.activity enforces Odoo's real contract:
        //  - `res_model` is a READONLY related field of `res_model_id`; any
        //    incoming value is dropped (writing it is a no-op in Odoo).
        //  - the SQL CHECK `res_id IS NOT NULL AND res_id != 0` rejects an
        //    activity that is not linked to a concrete record. Without a
        //    `res_model_id` the related `res_model` stays empty and the
        //    many2one_reference `res_id` never persists — which is exactly
        //    how a create that only passes `res_model` + `res_id` fails.
        if (model === "mail.activity") {
          delete values.res_model;
          if (!values.res_model_id || !values.res_id) {
            return {
              __jsonrpc_error: true,
              message:
                "Activities have to be linked to records with a not null res_id.",
            };
          }
          // Compute the readonly related `res_model` from res_model_id so
          // reads surface it the way Odoo does.
          const irModelId = Array.isArray(values.res_model_id)
            ? values.res_model_id[0]
            : values.res_model_id;
          const modelRec = (store.get("ir.model") || []).find(
            (r) => r.id === irModelId,
          );
          if (modelRec) values.res_model = modelRec.model;
        }

        const newId = nextIds.get(model) || 1;
        nextIds.set(model, newId + 1);

        // Validate top-level m2o values (Odoo rejects bare-string m2o ids;
        // the plugin resolves refs/names to ints before reaching here).
        const topErr = validateM2oFields(model, values);
        if (topErr) return topErr;

        // Materialize one2many command tuples into child records (e.g.
        // account.move `line_ids: [[0, 0, { account_id, debit, credit }]]`
        // → account.move.line rows with a move_id back-link), and validate
        // their nested m2o values.
        const modelFieldDefs = MODEL_FIELDS[model] || {};
        for (const [name, def] of Object.entries(modelFieldDefs)) {
          if (def.type !== "one2many" || !def.relation) continue;
          if (!Array.isArray(values[name])) continue;
          const result = processOne2ManyTuples(
            model,
            name,
            def.relation,
            values[name],
            newId,
          );
          if (result && result.__jsonrpc_error) return result;
          values[name] = result;
        }

        const newRecord = { id: newId, ...values };
        store.get(model).push(newRecord);
        return newId;
      }

      // write
      if (objMethod === "write") {
        const ids = positionalArgs[0] || [];
        const values = positionalArgs[1] || {};
        for (const record of store.get(model)) {
          if (ids.includes(record.id)) {
            Object.assign(record, values);
          }
        }
        return true;
      }

      // check_access_rights
      if (objMethod === "check_access_rights") {
        const operation = positionalArgs[0]; // "read", "create", "write", "unlink"
        const raiseException = kwArgs?.raise_exception !== false;
        // Default: all rights true when not explicitly configured
        const modelRights = accessRights[model];
        const hasAccess = modelRights ? (modelRights[operation] ?? true) : true;
        if (!hasAccess && raiseException) {
          return {
            __jsonrpc_error: true,
            message: "AccessError: permission denied",
          };
        }
        return hasAccess;
      }

      // unlink
      if (objMethod === "unlink") {
        const ids = positionalArgs[0] || [];
        store.set(
          model,
          store.get(model).filter((r) => !ids.includes(r.id)),
        );
        return true;
      }

      // mail.activity.action_feedback — mark an activity done. In real Odoo
      // this posts a completion message to the chatter and then unlinks the
      // activity; we model the unlink (the visible end state) and ignore the
      // optional `feedback` kwarg.
      if (objMethod === "action_feedback") {
        const ids = positionalArgs[0] || [];
        store.set(
          model,
          store.get(model).filter((r) => !ids.includes(r.id)),
        );
        return true;
      }

      // Generic record-action methods (action_*, button_*, and a few approval
      // methods). In real Odoo these return `true` when they finish cleanly,
      // or an `ir.actions.act_window` dict when a wizard (backorder, etc.) is
      // needed. Default to `true`; a test can override the result per
      // (model, method) via POST /control/method-response to simulate a wizard.
      if (
        /^(action_|button_)/.test(objMethod) ||
        objMethod === "approve_expense_sheets" ||
        objMethod === "refuse_sheet"
      ) {
        const key = `${model}.${objMethod}`;
        return key in methodResponses ? methodResponses[key] : true;
      }

      return false;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch {
        resolve(null);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data);
  res.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function parseQuery(url) {
  const idx = url.indexOf("?");
  if (idx === -1) return {};
  const params = {};
  const qs = url.slice(idx + 1);
  for (const pair of qs.split("&")) {
    const [k, v] = pair.split("=");
    params[decodeURIComponent(k)] = decodeURIComponent(v || "");
  }
  return params;
}

// ---------------------------------------------------------------------------
// Port 8069 — Fake Odoo JSON-RPC API
// ---------------------------------------------------------------------------
const jsonRpcServer = http.createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/jsonrpc") {
    const body = await readBody(req);
    if (!body) {
      sendJson(res, 400, {
        jsonrpc: "2.0",
        id: null,
        error: { message: "Invalid JSON" },
      });
      return;
    }

    const result = handleJsonRpc(body);
    if (result && result.__jsonrpc_error) {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: body.id || null,
        error: {
          message: result.message,
          code: 200,
          data: { message: result.message },
        },
      });
    } else {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: body.id || null,
        result: result,
      });
    }
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

// ---------------------------------------------------------------------------
// Port 9002 — Control API for tests
// ---------------------------------------------------------------------------
const controlServer = http.createServer(async (req, res) => {
  const path = req.url.split("?")[0];

  // Health check
  if (req.method === "GET" && path === "/control/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // Configure a record-action method to return a wizard action (instead of
  // the default `true`), to exercise the Variant A handoff path.
  // Body: { model, method, response }
  if (req.method === "POST" && path === "/control/method-response") {
    const body = await readBody(req);
    if (!body || !body.model || !body.method) {
      sendJson(res, 400, { error: "Need { model, method, response }" });
      return;
    }
    methodResponses[`${body.model}.${body.method}`] = body.response;
    sendJson(res, 200, { status: "configured" });
    return;
  }

  // Reset to defaults
  if (req.method === "POST" && path === "/control/reset") {
    store = new Map(Object.entries(getDefaultRecords()));
    resetNextIds();
    accessRights = {};
    methodResponses = {};
    authMode = "ok";
    authConfig = {
      db: "testdb",
      login: "admin",
      apiKey: "test-api-key",
      uid: 2,
    };
    sendJson(res, 200, { status: "reset" });
    return;
  }

  // Seed records
  if (req.method === "POST" && path === "/control/seed") {
    const body = await readBody(req);
    if (!body || !body.model || !Array.isArray(body.records)) {
      sendJson(res, 400, { error: "Need { model, records }" });
      return;
    }
    ensureModel(body.model);
    for (const record of body.records) {
      if (record.id) {
        // Remove existing record with same id
        store.set(
          body.model,
          store.get(body.model).filter((r) => r.id !== record.id),
        );
        store.get(body.model).push(record);
        if (record.id >= (nextIds.get(body.model) || 1)) {
          nextIds.set(body.model, record.id + 1);
        }
      } else {
        const newId = nextIds.get(body.model) || 1;
        nextIds.set(body.model, newId + 1);
        store.get(body.model).push({ id: newId, ...record });
      }
    }
    sendJson(res, 200, {
      status: "seeded",
      count: body.records.length,
    });
    return;
  }

  // Get records
  if (req.method === "GET" && path === "/control/records") {
    const query = parseQuery(req.url);
    const model = query.model;
    if (!model) {
      sendJson(res, 400, { error: "Need ?model= parameter" });
      return;
    }
    sendJson(res, 200, store.get(model) || []);
    return;
  }

  // Configure access rights
  if (req.method === "POST" && path === "/control/access-rights") {
    const body = await readBody(req);
    if (body && typeof body === "object") {
      Object.assign(accessRights, body);
    }
    sendJson(res, 200, { status: "configured", accessRights });
    return;
  }

  // Configure auth
  if (req.method === "POST" && path === "/control/configure") {
    const body = await readBody(req);
    if (body) {
      if (body.db) authConfig.db = body.db;
      if (body.login) authConfig.login = body.login;
      if (body.apiKey) authConfig.apiKey = body.apiKey;
      if (body.uid) authConfig.uid = body.uid;
    }
    sendJson(res, 200, { status: "configured", config: authConfig });
    return;
  }

  // Toggle auth failure mode: POST /control/auth-mode { mode: "ok" | "fail" }
  if (req.method === "POST" && path === "/control/auth-mode") {
    const body = await readBody(req);
    if (!body || (body.mode !== "ok" && body.mode !== "fail")) {
      sendJson(res, 400, { error: 'Need { mode: "ok" | "fail" }' });
      return;
    }
    authMode = body.mode;
    sendJson(res, 200, { status: "ok", authMode });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

// ---------------------------------------------------------------------------
// Public API for in-process consumers (vitest integration tests).
//
// Auto-starts on the published Docker ports when run as a CLI (e.g. inside
// the docker-compose service). Tests can instead import the module and
// call `start()` to spin both servers up on ephemeral ports without
// touching the docker-compose stack.
// ---------------------------------------------------------------------------
resetNextIds();

async function start({ jsonRpcPort = 8069, controlPort = 9002, host } = {}) {
  await new Promise((resolve) =>
    jsonRpcServer.listen(jsonRpcPort, host, resolve),
  );
  await new Promise((resolve) =>
    controlServer.listen(controlPort, host, resolve),
  );
  return {
    jsonRpcPort: jsonRpcServer.address().port,
    controlPort: controlServer.address().port,
    async stop() {
      await Promise.all([
        new Promise((r) => jsonRpcServer.close(r)),
        new Promise((r) => controlServer.close(r)),
      ]);
    },
  };
}

if (require.main === module) {
  start().then(({ jsonRpcPort, controlPort }) => {
    console.log(`Mock Odoo JSON-RPC server listening on port ${jsonRpcPort}`);
    console.log(`Mock Odoo Control API listening on port ${controlPort}`);
  });
}

module.exports = { start };
