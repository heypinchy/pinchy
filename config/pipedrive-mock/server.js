// Mock Pipedrive REST API server for E2E testing
// CommonJS, zero dependencies — runs on plain Node.js

const http = require("http");

// ---------------------------------------------------------------------------
// Default auth config (configurable via /control/configure)
// ---------------------------------------------------------------------------
let apiToken = "test-pipedrive-token";

// ---------------------------------------------------------------------------
// Per-entity access control (entity → HTTP status code, e.g. 403)
// ---------------------------------------------------------------------------
let entityAccess = {};

// ---------------------------------------------------------------------------
// Default seed data
// ---------------------------------------------------------------------------
function getDefaultRecords() {
  return {
    deals: [
      { id: 1, title: "Acme Corp Deal", value: 5000, currency: "EUR", status: "open", pipeline_id: 1, stage_id: 1, person_id: 1, org_id: 1 },
      { id: 2, title: "Beta Inc Deal", value: 8000, currency: "EUR", status: "open", pipeline_id: 1, stage_id: 2, person_id: 2, org_id: 2 },
      { id: 3, title: "Gamma Ltd Deal", value: 2000, currency: "EUR", status: "won", pipeline_id: 1, stage_id: 3, person_id: 3, org_id: 1 },
    ],
    persons: [
      { id: 1, name: "John Doe", email: [{ value: "john@acme.com", primary: true }], phone: [{ value: "+1234567890", primary: true }], org_id: 1 },
      { id: 2, name: "Jane Smith", email: [{ value: "jane@beta.com", primary: true }], phone: [], org_id: 2 },
      { id: 3, name: "Bob Wilson", email: [{ value: "bob@acme.com", primary: true }], phone: [], org_id: 1 },
    ],
    organizations: [
      { id: 1, name: "Acme Corp", address: "123 Main St" },
      { id: 2, name: "Beta Inc", address: "456 Oak Ave" },
    ],
    pipelines: [
      { id: 1, name: "Sales Pipeline", active: true, deal_probability: true },
    ],
    stages: [
      { id: 1, name: "Lead In", pipeline_id: 1, order_nr: 1 },
      { id: 2, name: "Qualified", pipeline_id: 1, order_nr: 2 },
      { id: 3, name: "Won", pipeline_id: 1, order_nr: 3 },
    ],
    activities: [],
    products: [
      { id: 1, name: "Product A", prices: [{ price: 100, currency: "EUR" }] },
    ],
    leads: [],
    notes: [],
    files: [],
    projects: [],
    tasks: [],
    goals: [],
  };
}

// ---------------------------------------------------------------------------
// Field definitions per entity
// ---------------------------------------------------------------------------
const FIELD_DEFINITIONS = {
  dealFields: [
    { key: "title", name: "Title", field_type: "varchar", mandatory_flag: true, options: null },
    { key: "value", name: "Value", field_type: "monetary", mandatory_flag: false, options: null },
    { key: "currency", name: "Currency", field_type: "varchar", mandatory_flag: false, options: null },
    { key: "status", name: "Status", field_type: "enum", mandatory_flag: false, options: [{ id: 1, label: "open" }, { id: 2, label: "won" }, { id: 3, label: "lost" }] },
    { key: "pipeline_id", name: "Pipeline", field_type: "int", mandatory_flag: false, options: null },
    { key: "stage_id", name: "Stage", field_type: "int", mandatory_flag: false, options: null },
    { key: "person_id", name: "Person", field_type: "int", mandatory_flag: false, options: null },
    { key: "org_id", name: "Organization", field_type: "int", mandatory_flag: false, options: null },
  ],
  personFields: [
    { key: "name", name: "Name", field_type: "varchar", mandatory_flag: true, options: null },
    { key: "email", name: "Email", field_type: "varchar", mandatory_flag: false, options: null },
    { key: "phone", name: "Phone", field_type: "phone", mandatory_flag: false, options: null },
    { key: "org_id", name: "Organization", field_type: "int", mandatory_flag: false, options: null },
  ],
  organizationFields: [
    { key: "name", name: "Name", field_type: "varchar", mandatory_flag: true, options: null },
    { key: "address", name: "Address", field_type: "varchar", mandatory_flag: false, options: null },
  ],
  activityFields: [
    { key: "subject", name: "Subject", field_type: "varchar", mandatory_flag: true, options: null },
    { key: "type", name: "Type", field_type: "enum", mandatory_flag: false, options: [{ id: 1, label: "call" }, { id: 2, label: "meeting" }, { id: 3, label: "email" }] },
    { key: "due_date", name: "Due Date", field_type: "date", mandatory_flag: false, options: null },
    { key: "done", name: "Done", field_type: "boolean", mandatory_flag: false, options: null },
    { key: "deal_id", name: "Deal", field_type: "int", mandatory_flag: false, options: null },
    { key: "person_id", name: "Person", field_type: "int", mandatory_flag: false, options: null },
    { key: "org_id", name: "Organization", field_type: "int", mandatory_flag: false, options: null },
  ],
  productFields: [
    { key: "name", name: "Name", field_type: "varchar", mandatory_flag: true, options: null },
    { key: "prices", name: "Prices", field_type: "varchar", mandatory_flag: false, options: null },
  ],
  noteFields: [
    { key: "content", name: "Content", field_type: "text", mandatory_flag: true, options: null },
    { key: "deal_id", name: "Deal", field_type: "int", mandatory_flag: false, options: null },
    { key: "person_id", name: "Person", field_type: "int", mandatory_flag: false, options: null },
    { key: "org_id", name: "Organization", field_type: "int", mandatory_flag: false, options: null },
  ],
  leadFields: [
    { key: "title", name: "Title", field_type: "varchar", mandatory_flag: true, options: null },
    { key: "person_id", name: "Person", field_type: "int", mandatory_flag: false, options: null },
    { key: "organization_id", name: "Organization", field_type: "int", mandatory_flag: false, options: null },
    { key: "value", name: "Value", field_type: "monetary", mandatory_flag: false, options: null },
    { key: "currency", name: "Currency", field_type: "varchar", mandatory_flag: false, options: null },
  ],
};

// ---------------------------------------------------------------------------
// In-memory data store
// ---------------------------------------------------------------------------
let store = getDefaultRecords();
let nextIds = {};

// v2 entities use { data: ... } responses (no success field)
const V2_ENTITIES = new Set(["deals", "persons", "organizations", "activities", "products", "pipelines", "stages"]);
// v1 entities use { success: true, data: ... } responses
const V1_ENTITIES = new Set(["leads", "notes", "files", "projects", "tasks", "goals"]);

// Deal relationship stores
let dealProducts = []; // { id, deal_id, product_id, ... }
let dealParticipants = []; // { id, deal_id, person_id, ... }
let entityFollowers = []; // { id, entity, entity_id, user_id, ... }
let nextDealProductId = 1;
let nextDealParticipantId = 1;
let nextEntityFollowerId = 1;

function resetNextIds() {
  nextIds = {};
  for (const [entity, records] of Object.entries(store)) {
    const maxId = records.reduce((m, r) => Math.max(m, r.id || 0), 0);
    nextIds[entity] = maxId + 1;
  }
}

function ensureEntity(entity) {
  if (!store[entity]) {
    store[entity] = [];
    nextIds[entity] = 1;
  }
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

function parsePath(url) {
  return url.split("?")[0];
}

// ---------------------------------------------------------------------------
// Auth check
// ---------------------------------------------------------------------------
function checkAuth(req, res) {
  const token = req.headers["x-api-token"];
  if (!token || token !== apiToken) {
    sendJson(res, 401, { success: false, error: "Unauthorized" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Entity access check (returns true if accessible)
// ---------------------------------------------------------------------------
function checkEntityAccess(entity, res) {
  const status = entityAccess[entity];
  if (status === 403) {
    sendJson(res, 403, { success: false, error: "Plan does not include this feature" });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Route matching helpers
// ---------------------------------------------------------------------------
function matchRoute(method, path, pattern) {
  if (typeof pattern === "string") {
    return method === null || req.method === method ? path === pattern : false;
  }
  // Pattern with :params
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

function extractParams(path, pattern) {
  const patternParts = pattern.split("/");
  const pathParts = path.split("/");
  if (patternParts.length !== pathParts.length) return null;
  const params = {};
  for (let i = 0; i < patternParts.length; i++) {
    if (patternParts[i].startsWith(":")) {
      params[patternParts[i].slice(1)] = pathParts[i];
    } else if (patternParts[i] !== pathParts[i]) {
      return null;
    }
  }
  return params;
}

// ---------------------------------------------------------------------------
// Port 8080 — Mock Pipedrive REST API
// ---------------------------------------------------------------------------
const apiServer = http.createServer(async (req, res) => {
  const path = parsePath(req.url);
  const query = parseQuery(req.url);
  const method = req.method;

  // Auth check for all API endpoints
  if (!checkAuth(req, res)) return;

  // -------------------------------------------------------------------------
  // GET /v1/users/me
  // -------------------------------------------------------------------------
  if (method === "GET" && path === "/v1/users/me") {
    sendJson(res, 200, {
      success: true,
      data: {
        id: 1,
        name: "Test User",
        company_domain: "test-company",
        company_name: "Test Company",
      },
    });
    return;
  }

  // -------------------------------------------------------------------------
  // GET /v2/itemSearch
  // -------------------------------------------------------------------------
  if (method === "GET" && path === "/v2/itemSearch") {
    const term = (query.term || "").toLowerCase();
    const itemTypes = query.item_types ? query.item_types.split(",") : [];
    const limit = parseInt(query.limit, 10) || 50;
    const items = [];

    const entityToType = {
      deals: "deal",
      persons: "person",
      organizations: "organization",
      products: "product",
      leads: "lead",
    };

    for (const [entity, type] of Object.entries(entityToType)) {
      if (itemTypes.length > 0 && !itemTypes.includes(type)) continue;
      const records = store[entity] || [];
      for (const record of records) {
        const searchField = record.title || record.name || "";
        if (searchField.toLowerCase().includes(term)) {
          items.push({ type, item: { ...record } });
        }
        if (items.length >= limit) break;
      }
      if (items.length >= limit) break;
    }

    sendJson(res, 200, { data: { items } });
    return;
  }

  // -------------------------------------------------------------------------
  // GET /v1/deals/summary
  // -------------------------------------------------------------------------
  if (method === "GET" && path === "/v1/deals/summary") {
    const deals = store.deals || [];
    const openDeals = deals.filter((d) => d.status === "open");
    const wonDeals = deals.filter((d) => d.status === "won");
    const lostDeals = deals.filter((d) => d.status === "lost");
    const totalAmount = deals.reduce((sum, d) => sum + (d.value || 0), 0);

    sendJson(res, 200, {
      success: true,
      data: {
        total_count: deals.length,
        total_currency_default_amount: totalAmount,
        open_count: openDeals.length,
        won_count: wonDeals.length,
        lost_count: lostDeals.length,
      },
    });
    return;
  }

  // -------------------------------------------------------------------------
  // Pipeline statistics: /v1/pipelines/:id/conversion_statistics
  // -------------------------------------------------------------------------
  {
    const params = extractParams(path, "/v1/pipelines/:id/conversion_statistics");
    if (method === "GET" && params) {
      sendJson(res, 200, {
        success: true,
        data: {
          stage_conversions: [
            { from_stage_id: 1, to_stage_id: 2, conversion_rate: 0.75 },
            { from_stage_id: 2, to_stage_id: 3, conversion_rate: 0.5 },
          ],
          won_conversion: 0.33,
          lost_conversion: 0.1,
        },
      });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Pipeline statistics: /v1/pipelines/:id/movement_statistics
  // -------------------------------------------------------------------------
  {
    const params = extractParams(path, "/v1/pipelines/:id/movement_statistics");
    if (method === "GET" && params) {
      sendJson(res, 200, {
        success: true,
        data: {
          movements_between_stages: {
            count: 5,
          },
          new_deals: { count: 3 },
          deals_left: { count: 1 },
          average_age_in_days: { across_all_stages: 12 },
        },
      });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Deal products: POST /v1/deals/:id/products
  // -------------------------------------------------------------------------
  {
    const params = extractParams(path, "/v1/deals/:id/products");
    if (method === "POST" && params) {
      const dealId = parseInt(params.id, 10);
      const body = await readBody(req);
      const attachmentId = nextDealProductId++;
      const entry = { id: attachmentId, deal_id: dealId, ...body };
      dealProducts.push(entry);
      sendJson(res, 200, { success: true, data: entry });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Deal products: DELETE /v1/deals/:id/products/:attachmentId
  // -------------------------------------------------------------------------
  {
    const params = extractParams(path, "/v1/deals/:dealId/products/:attachmentId");
    if (method === "DELETE" && params) {
      const attachmentId = parseInt(params.attachmentId, 10);
      dealProducts = dealProducts.filter((dp) => dp.id !== attachmentId);
      sendJson(res, 200, { success: true, data: { id: attachmentId } });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Deal participants: POST /v1/deals/:id/participants
  // -------------------------------------------------------------------------
  {
    const params = extractParams(path, "/v1/deals/:id/participants");
    if (method === "POST" && params) {
      const dealId = parseInt(params.id, 10);
      const body = await readBody(req);
      const participantId = nextDealParticipantId++;
      const entry = { id: participantId, deal_id: dealId, ...body };
      dealParticipants.push(entry);
      sendJson(res, 200, { success: true, data: entry });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Deal participants: DELETE /v1/deals/:id/participants/:participantId
  // -------------------------------------------------------------------------
  {
    const params = extractParams(path, "/v1/deals/:dealId/participants/:participantId");
    if (method === "DELETE" && params) {
      const participantId = parseInt(params.participantId, 10);
      dealParticipants = dealParticipants.filter((dp) => dp.id !== participantId);
      sendJson(res, 200, { success: true, data: { id: participantId } });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Followers: POST /v1/<entity>/:id/followers
  // -------------------------------------------------------------------------
  {
    const followerAddMatch = path.match(/^\/v1\/([a-z]+)\/(\d+)\/followers$/);
    if (method === "POST" && followerAddMatch) {
      const entity = followerAddMatch[1];
      const entityId = parseInt(followerAddMatch[2], 10);
      const body = await readBody(req);
      const followerId = nextEntityFollowerId++;
      const entry = { id: followerId, entity, entity_id: entityId, ...body };
      entityFollowers.push(entry);
      sendJson(res, 200, { success: true, data: entry });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Followers: DELETE /v1/<entity>/:id/followers/:followerId
  // -------------------------------------------------------------------------
  {
    const followerDelMatch = path.match(/^\/v1\/([a-z]+)\/(\d+)\/followers\/(\d+)$/);
    if (method === "DELETE" && followerDelMatch) {
      const followerId = parseInt(followerDelMatch[3], 10);
      entityFollowers = entityFollowers.filter((f) => f.id !== followerId);
      sendJson(res, 200, { success: true, data: { id: followerId } });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Merge: PUT /v1/<entity>/:id/merge
  // -------------------------------------------------------------------------
  {
    const mergeMatch = path.match(/^\/v1\/([a-z]+)\/(\d+)\/merge$/);
    if (method === "PUT" && mergeMatch) {
      const entity = mergeMatch[1];
      const targetId = parseInt(mergeMatch[2], 10);
      const body = await readBody(req);
      const mergeWithId = body && body.merge_with_id;

      ensureEntity(entity);
      const records = store[entity];
      const targetRecord = records.find((r) => r.id === targetId);
      if (!targetRecord) {
        sendJson(res, 404, { success: false, error: "Not found" });
        return;
      }
      // Remove the merged record
      store[entity] = records.filter((r) => r.id !== mergeWithId);
      sendJson(res, 200, { success: true, data: targetRecord });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Lead conversion: POST /v2/leads/:id/convert/deal
  // -------------------------------------------------------------------------
  {
    const params = extractParams(path, "/v2/leads/:id/convert/deal");
    if (method === "POST" && params) {
      const leadId = parseInt(params.id, 10);
      ensureEntity("leads");
      const lead = (store.leads || []).find((l) => l.id === leadId);
      if (!lead) {
        sendJson(res, 404, { data: null });
        return;
      }
      // Create a deal from the lead
      ensureEntity("deals");
      const dealId = nextIds.deals || 1;
      nextIds.deals = dealId + 1;
      const newDeal = { id: dealId, title: lead.title || "Converted Lead", value: lead.value || 0, currency: lead.currency || "EUR", status: "open", pipeline_id: 1, stage_id: 1 };
      store.deals.push(newDeal);
      // Remove the lead
      store.leads = store.leads.filter((l) => l.id !== leadId);
      sendJson(res, 200, { data: newDeal });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Deal to lead conversion: POST /v2/deals/:id/convert/lead
  // -------------------------------------------------------------------------
  {
    const params = extractParams(path, "/v2/deals/:id/convert/lead");
    if (method === "POST" && params) {
      const dealId = parseInt(params.id, 10);
      ensureEntity("deals");
      const deal = (store.deals || []).find((d) => d.id === dealId);
      if (!deal) {
        sendJson(res, 404, { data: null });
        return;
      }
      // Create a lead from the deal
      ensureEntity("leads");
      const leadId = nextIds.leads || 1;
      nextIds.leads = leadId + 1;
      const newLead = { id: leadId, title: deal.title || "Converted Deal", value: deal.value || 0, currency: deal.currency || "EUR" };
      store.leads.push(newLead);
      // Remove the deal
      store.deals = store.deals.filter((d) => d.id !== dealId);
      sendJson(res, 200, { data: newLead });
      return;
    }
  }

  // -------------------------------------------------------------------------
  // Field definitions: GET /v1/<entity>Fields
  // -------------------------------------------------------------------------
  {
    const fieldsMatch = path.match(/^\/v1\/([a-zA-Z]+Fields)$/);
    if (method === "GET" && fieldsMatch) {
      const fieldsKey = fieldsMatch[1];
      const fields = FIELD_DEFINITIONS[fieldsKey];
      if (fields) {
        sendJson(res, 200, { success: true, data: fields });
      } else {
        sendJson(res, 200, { success: true, data: [] });
      }
      return;
    }
  }

  // -------------------------------------------------------------------------
  // v2 CRUD: /v2/<entity> and /v2/<entity>/:id
  // -------------------------------------------------------------------------
  {
    // Match /v2/<entity>/:id
    const v2SingleMatch = path.match(/^\/v2\/([a-z]+)\/(\d+)$/);
    if (v2SingleMatch) {
      const entity = v2SingleMatch[1];
      const id = parseInt(v2SingleMatch[2], 10);

      if (!V2_ENTITIES.has(entity)) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      if (!checkEntityAccess(entity, res)) return;
      ensureEntity(entity);

      if (method === "GET") {
        const record = store[entity].find((r) => r.id === id);
        if (!record) {
          sendJson(res, 404, { data: null });
          return;
        }
        sendJson(res, 200, { data: record });
        return;
      }

      if (method === "PATCH") {
        const body = await readBody(req);
        const record = store[entity].find((r) => r.id === id);
        if (!record) {
          sendJson(res, 404, { data: null });
          return;
        }
        Object.assign(record, body);
        sendJson(res, 200, { data: record });
        return;
      }

      if (method === "DELETE") {
        const record = store[entity].find((r) => r.id === id);
        if (!record) {
          sendJson(res, 404, { data: null });
          return;
        }
        store[entity] = store[entity].filter((r) => r.id !== id);
        sendJson(res, 200, { data: { id } });
        return;
      }
    }

    // Match /v2/<entity>
    const v2ListMatch = path.match(/^\/v2\/([a-z]+)$/);
    if (v2ListMatch) {
      const entity = v2ListMatch[1];

      if (!V2_ENTITIES.has(entity)) {
        sendJson(res, 404, { error: "Not found" });
        return;
      }
      if (!checkEntityAccess(entity, res)) return;
      ensureEntity(entity);

      if (method === "GET") {
        const limit = parseInt(query.limit, 10) || 100;
        const cursor = parseInt(query.cursor, 10) || 0;
        const records = store[entity].slice(cursor, cursor + limit);
        const hasMore = cursor + limit < store[entity].length;
        sendJson(res, 200, {
          data: records,
          additional_data: {
            pagination: {
              more_items_in_collection: hasMore,
              next_cursor: hasMore ? cursor + limit : null,
            },
          },
        });
        return;
      }

      if (method === "POST") {
        const body = await readBody(req);
        const newId = nextIds[entity] || 1;
        nextIds[entity] = newId + 1;
        const newRecord = { id: newId, ...body };
        store[entity].push(newRecord);
        sendJson(res, 201, { data: newRecord });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // v1 CRUD: /v1/<entity> and /v1/<entity>/:id
  // -------------------------------------------------------------------------
  {
    // Match /v1/<entity>/:id
    const v1SingleMatch = path.match(/^\/v1\/([a-z]+)\/(\d+)$/);
    if (v1SingleMatch) {
      const entity = v1SingleMatch[1];
      const id = parseInt(v1SingleMatch[2], 10);

      if (!V1_ENTITIES.has(entity)) {
        // Also support v1 access to v2 entities (for entity probe / field listing)
        if (!V2_ENTITIES.has(entity)) {
          sendJson(res, 404, { success: false, error: "Not found" });
          return;
        }
      }
      if (!checkEntityAccess(entity, res)) return;
      ensureEntity(entity);

      if (method === "GET") {
        const record = store[entity].find((r) => r.id === id);
        if (!record) {
          sendJson(res, 404, { success: false, error: "Not found" });
          return;
        }
        sendJson(res, 200, { success: true, data: record });
        return;
      }

      if (method === "PUT") {
        const body = await readBody(req);
        const record = store[entity].find((r) => r.id === id);
        if (!record) {
          sendJson(res, 404, { success: false, error: "Not found" });
          return;
        }
        Object.assign(record, body);
        sendJson(res, 200, { success: true, data: record });
        return;
      }

      if (method === "DELETE") {
        const record = store[entity].find((r) => r.id === id);
        if (!record) {
          sendJson(res, 404, { success: false, error: "Not found" });
          return;
        }
        store[entity] = store[entity].filter((r) => r.id !== id);
        sendJson(res, 200, { success: true, data: { id } });
        return;
      }
    }

    // Match /v1/<entity> (list / create)
    const v1ListMatch = path.match(/^\/v1\/([a-z]+)$/);
    if (v1ListMatch) {
      const entity = v1ListMatch[1];

      if (!V1_ENTITIES.has(entity) && !V2_ENTITIES.has(entity)) {
        sendJson(res, 404, { success: false, error: "Not found" });
        return;
      }
      if (!checkEntityAccess(entity, res)) return;
      ensureEntity(entity);

      if (method === "GET") {
        const limit = parseInt(query.limit, 10) || 100;
        const start = parseInt(query.start, 10) || 0;
        const records = store[entity].slice(start, start + limit);
        const hasMore = start + limit < store[entity].length;
        sendJson(res, 200, {
          success: true,
          data: records.length > 0 ? records : null,
          additional_data: {
            pagination: {
              more_items_in_collection: hasMore,
            },
          },
        });
        return;
      }

      if (method === "POST") {
        const body = await readBody(req);
        const newId = nextIds[entity] || 1;
        nextIds[entity] = newId + 1;
        const newRecord = { id: newId, ...body };
        store[entity].push(newRecord);
        sendJson(res, 201, { success: true, data: newRecord });
        return;
      }
    }
  }

  // -------------------------------------------------------------------------
  // Fallback
  // -------------------------------------------------------------------------
  sendJson(res, 404, { success: false, error: "Not found" });
});

// ---------------------------------------------------------------------------
// Port 9003 — Control API for tests
// ---------------------------------------------------------------------------
const controlServer = http.createServer(async (req, res) => {
  const path = parsePath(req.url);
  const query = parseQuery(req.url);

  // Health check
  if (req.method === "GET" && path === "/control/health") {
    sendJson(res, 200, { status: "ok" });
    return;
  }

  // Reset to defaults
  if (req.method === "POST" && path === "/control/reset") {
    store = getDefaultRecords();
    resetNextIds();
    entityAccess = {};
    apiToken = "test-pipedrive-token";
    dealProducts = [];
    dealParticipants = [];
    entityFollowers = [];
    nextDealProductId = 1;
    nextDealParticipantId = 1;
    nextEntityFollowerId = 1;
    sendJson(res, 200, { status: "reset" });
    return;
  }

  // Seed records
  if (req.method === "POST" && path === "/control/seed") {
    const body = await readBody(req);
    if (!body || !body.entity || !Array.isArray(body.records)) {
      sendJson(res, 400, { error: "Need { entity, records }" });
      return;
    }
    ensureEntity(body.entity);
    for (const record of body.records) {
      if (record.id) {
        // Remove existing record with same id
        store[body.entity] = store[body.entity].filter((r) => r.id !== record.id);
        store[body.entity].push(record);
        if (record.id >= (nextIds[body.entity] || 1)) {
          nextIds[body.entity] = record.id + 1;
        }
      } else {
        const newId = nextIds[body.entity] || 1;
        nextIds[body.entity] = newId + 1;
        store[body.entity].push({ id: newId, ...record });
      }
    }
    sendJson(res, 200, { status: "seeded", count: body.records.length });
    return;
  }

  // Configure entity access
  if (req.method === "POST" && path === "/control/access") {
    const body = await readBody(req);
    if (body && typeof body === "object") {
      Object.assign(entityAccess, body);
    }
    sendJson(res, 200, { status: "configured", entityAccess });
    return;
  }

  // Configure auth
  if (req.method === "POST" && path === "/control/configure") {
    const body = await readBody(req);
    if (body) {
      if (body.apiToken) apiToken = body.apiToken;
    }
    sendJson(res, 200, { status: "configured", config: { apiToken } });
    return;
  }

  // Get records
  if (req.method === "GET" && path === "/control/records") {
    const entity = query.entity;
    if (!entity) {
      sendJson(res, 400, { error: "Need ?entity= parameter" });
      return;
    }
    sendJson(res, 200, store[entity] || []);
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

// ---------------------------------------------------------------------------
// Start servers
// ---------------------------------------------------------------------------
resetNextIds();

apiServer.listen(8080, () => {
  console.log("Mock Pipedrive API server listening on port 8080");
});

controlServer.listen(9003, () => {
  console.log("Mock Pipedrive Control API listening on port 9003");
});
