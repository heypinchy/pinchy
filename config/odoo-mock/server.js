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
      },
      {
        id: 2,
        name: "Bauer AG",
        email: "office@bauer.at",
        phone: "+43 316 987654",
        is_company: true,
        zip: "8010",
        state_id: [2, "Steiermark"],
      },
      {
        id: 3,
        name: "Schmidt KG",
        email: "schmidt@schmidt.at",
        phone: "+43 732 456789",
        is_company: true,
        zip: "4020",
        state_id: [3, "Oberösterreich"],
      },
      {
        id: 4,
        name: "Weber & Co",
        email: "weber@weber.at",
        phone: "+43 662 112233",
        is_company: true,
        zip: "5020",
        state_id: [4, "Salzburg"],
      },
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
    ],
  };
}

// In-memory data store
let store = getDefaultRecords();
let nextIds = {}; // per-model auto-increment counters
let accessRights = {}; // { "sale.order": { read: true, create: false, ... } }

function resetNextIds() {
  nextIds = {};
  for (const [model, records] of Object.entries(store)) {
    const maxId = records.reduce((m, r) => Math.max(m, r.id || 0), 0);
    nextIds[model] = maxId + 1;
  }
}

function ensureModel(model) {
  if (!store[model]) {
    store[model] = [];
    nextIds[model] = 1;
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
      return (
        typeof recordValue === "string" &&
        recordValue.includes(value)
      );
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
    return { field: tokens[0], desc: (tokens[1] || "asc").toLowerCase() === "desc" };
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
      const args = params.args || [];
      // args: [db, uid, apiKey, model, method, positionalArgs, kwArgs]
      const model = args[3];
      const objMethod = args[4];
      const positionalArgs = args[5] || [];
      const kwArgs = args[6] || {};

      ensureModel(model);
      const allRecords = store[model];

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

        let results = Object.entries(groups).map(([key, { records, rawKey }]) => {
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
                  0
                );
              }
            }
          }

          result["__domain"] = [[groupByField, "=", rawKey]];
          return result;
        });

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
        const values = positionalArgs[0] || {};
        const newId = nextIds[model] || 1;
        nextIds[model] = newId + 1;
        const newRecord = { id: newId, ...values };
        store[model].push(newRecord);
        return newId;
      }

      // write
      if (objMethod === "write") {
        const ids = positionalArgs[0] || [];
        const values = positionalArgs[1] || {};
        for (const record of store[model]) {
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
          return { __jsonrpc_error: true, message: "AccessError: permission denied" };
        }
        return hasAccess;
      }

      // unlink
      if (objMethod === "unlink") {
        const ids = positionalArgs[0] || [];
        store[model] = store[model].filter((r) => !ids.includes(r.id));
        return true;
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
        error: { message: result.message, code: 200, data: { message: result.message } },
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

  // Reset to defaults
  if (req.method === "POST" && path === "/control/reset") {
    store = getDefaultRecords();
    resetNextIds();
    accessRights = {};
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
        store[body.model] = store[body.model].filter(
          (r) => r.id !== record.id
        );
        store[body.model].push(record);
        if (record.id >= (nextIds[body.model] || 1)) {
          nextIds[body.model] = record.id + 1;
        }
      } else {
        const newId = nextIds[body.model] || 1;
        nextIds[body.model] = newId + 1;
        store[body.model].push({ id: newId, ...record });
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
    sendJson(res, 200, store[model] || []);
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

async function start({ jsonRpcPort = 8069, controlPort = 9002 } = {}) {
  await new Promise((resolve) => jsonRpcServer.listen(jsonRpcPort, resolve));
  await new Promise((resolve) => controlServer.listen(controlPort, resolve));
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
