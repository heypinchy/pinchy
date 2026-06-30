// @vitest-environment node
/**
 * Integration tests for pinchy-odoo against real mock-odoo and mock-pinchy
 * HTTP servers. Layer 2 of the #209 guardrails: catches anything that
 * breaks the actual chain
 *
 *   plugin → fetch credentials from Pinchy → odoo-node → Odoo JSON-RPC
 *
 * end-to-end. The unit tests in `tools.test.ts` mock both `odoo-node` and
 * `fetch`, so a regression in either the credentials-API contract or in
 * the way the apiKey reaches Odoo could slip past them. This file boots
 * an in-process instance of `config/odoo-mock/server.js` plus a tiny
 * in-test HTTP server that emulates Pinchy's
 * `/api/internal/integrations/<id>/credentials` endpoint, and exercises
 * the full chain.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createRequire } from "module";
import { createServer, type Server } from "http";
import { AddressInfo } from "net";
import plugin from "../index";
import { encodeRef } from "../integration-ref";

const require = createRequire(import.meta.url);

interface MockOdooHandle {
  jsonRpcPort: number;
  controlPort: number;
  stop: () => Promise<void>;
}

interface AgentTool {
  name: string;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

let mockOdoo: MockOdooHandle;
let mockPinchy: Server;
let mockPinchyPort: number;
const PINCHY_GATEWAY_TOKEN = "test-gateway-token-integration";

// Per-connection credentials served by the mock-pinchy. Tests can mutate
// this to simulate broken/missing/rotated credentials.
const credentialsByConnectionId = new Map<string, unknown>();

beforeAll(async () => {
  process.env.PINCHY_REF_TOKEN_KEY = "a".repeat(64);
  // Mock Odoo on an OS-picked port (no collision with the docker-compose service)
  const mockServer = require("../../../../config/odoo-mock/server.js") as {
    start: (opts: {
      jsonRpcPort: number;
      controlPort: number;
      host?: string;
    }) => Promise<MockOdooHandle>;
  };
  mockOdoo = await mockServer.start({
    jsonRpcPort: 0,
    controlPort: 0,
    host: "127.0.0.1",
  });

  // Mock Pinchy: implements just the credentials endpoint with the same
  // auth contract Pinchy itself uses (Bearer gateway token).
  mockPinchy = createServer((req, res) => {
    const auth = req.headers["authorization"];
    if (auth !== `Bearer ${PINCHY_GATEWAY_TOKEN}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }
    const match = req.url?.match(
      /^\/api\/internal\/integrations\/([^/]+)\/credentials$/,
    );
    if (!match) {
      res.writeHead(404);
      res.end();
      return;
    }
    const connectionId = match[1];
    const credentials = credentialsByConnectionId.get(connectionId);
    if (credentials === undefined) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Connection not found" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ type: "odoo", credentials }));
  });
  await new Promise<void>((resolve) =>
    mockPinchy.listen(0, "127.0.0.1", resolve),
  );
  mockPinchyPort = (mockPinchy.address() as AddressInfo).port;
});

afterAll(async () => {
  await mockOdoo?.stop();
  if (mockPinchy) {
    await new Promise<void>((resolve, reject) =>
      mockPinchy.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

function createApi(agentConfigs: Record<string, unknown> = {}) {
  const tools: Array<{
    factory: (ctx: { agentId?: string }) => AgentTool | null;
    name: string;
  }> = [];
  const api = {
    pluginConfig: {
      apiBaseUrl: `http://127.0.0.1:${mockPinchyPort}`,
      gatewayToken: PINCHY_GATEWAY_TOKEN,
      agents: agentConfigs,
    },
    registerTool: (
      factory: (ctx: { agentId?: string }) => AgentTool | null,
      opts?: { name?: string },
    ) => {
      tools.push({ factory, name: opts?.name ?? "" });
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (plugin as any).register(api);
  return tools;
}

function findTool(
  tools: ReturnType<typeof createApi>,
  name: string,
  agentId: string,
): AgentTool {
  const entry = tools.find((t) => t.name === name);
  if (!entry) throw new Error(`Tool ${name} not registered`);
  const tool = entry.factory({ agentId });
  if (!tool)
    throw new Error(`Tool ${name} factory returned null for agent ${agentId}`);
  return tool;
}

const agentId = "agent-integration";
const agentConfig = {
  connectionId: "conn-integration",
  permissions: {
    "sale.order": ["read"],
    "res.partner": ["read", "create", "write"],
  },
  modelNames: { "sale.order": "Sales Order", "res.partner": "Contact" },
};

describe("pinchy-odoo against real mock-odoo + mock-pinchy (#209 layer 2)", () => {
  beforeAll(() => {
    // Default: well-formed credentials pointing at the in-process mock-odoo.
    credentialsByConnectionId.set("conn-integration", {
      url: `http://127.0.0.1:${mockOdoo.jsonRpcPort}`,
      db: "testdb",
      uid: 2,
      apiKey: "test-api-key",
    });
  });

  it("odoo_describe_model returns the model's fields after a real round-trip through Pinchy + Odoo", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId);

    const result = await tool.execute("call-1", { model: "sale.order" });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.name).toBe("Sales Order");
    expect(data._meta.returned).toBeGreaterThan(0);
    expect(Object.keys(data.fields)).toContain("name");
  });

  it("odoo_count returns { count: number } for an empty filter", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId);

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(typeof data.count).toBe("number");
  });

  it("odoo_read returns records and total for an empty filter", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId);

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(Array.isArray(data.records)).toBe(true);
    expect(typeof data.total).toBe("number");
  });

  it("creates a partner with a country code lookup after a real Odoo round-trip", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId);

    const result = await tool.execute("call-create-country-lookup", {
      model: "res.partner",
      values: {
        name: "Lookup Partner",
        country_id: { lookup: { code: "AT" } },
      },
    });

    expect(result.isError).toBeFalsy();
    const { id } = JSON.parse(result.content[0].text) as { id: number };
    const records = (await fetch(
      `http://127.0.0.1:${mockOdoo.controlPort}/control/records?model=res.partner`,
    ).then((res) => res.json())) as Array<Record<string, unknown>>;
    expect(records.find((record) => record.id === id)).toMatchObject({
      name: "Lookup Partner",
      country_id: 14,
    });
  });

  it("reuses an emitted country ref in a subsequent write", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const readTool = findTool(tools, "odoo_read", agentId);
    const writeTool = findTool(tools, "odoo_write", agentId);

    const readResult = await readTool.execute("call-read-country-ref", {
      model: "res.partner",
      filters: [["id", "=", 1]],
      fields: ["name", "country_id"],
    });
    expect(readResult.isError).toBeFalsy();
    const readData = JSON.parse(readResult.content[0].text);
    const country = readData.records[0].country_id;
    expect(country).toMatchObject({
      ref: expect.stringMatching(/^pinchy_ref:v1:/),
      label: "Austria",
      model: "res.country",
    });

    const writeResult = await writeTool.execute("call-write-country-ref", {
      model: "res.partner",
      ids: [2],
      values: { country_id: { ref: country.ref } },
    });

    expect(writeResult.isError).toBeFalsy();
    const records = (await fetch(
      `http://127.0.0.1:${mockOdoo.controlPort}/control/records?model=res.partner`,
    ).then((res) => res.json())) as Array<Record<string, unknown>>;
    expect(records.find((record) => record.id === 2)).toMatchObject({
      country_id: 14,
    });
  });

  it("rejects raw numeric relation IDs before creating a record in Odoo", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId);

    const result = await tool.execute("call-create-raw-country", {
      model: "res.partner",
      values: { name: "Raw Numeric Partner", country_id: 14 },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "Raw numeric IDs are not accepted",
    );
    const records = (await fetch(
      `http://127.0.0.1:${mockOdoo.controlPort}/control/records?model=res.partner`,
    ).then((res) => res.json())) as Array<Record<string, unknown>>;
    expect(
      records.some((record) => record.name === "Raw Numeric Partner"),
    ).toBe(false);
  });

  it("REGRESSION (#209): if Pinchy returns the SecretRef-shaped dict instead of credentials, the plugin fails fast WITHOUT producing a Python crash", async () => {
    // Exactly the bug shape from staging: the credentials API returns the
    // unresolved SecretRef object instead of decrypted credentials. The
    // plugin must reject it at the boundary, not forward it to Odoo (which
    // would crash the Python server with `unhashable type: 'dict'`).
    credentialsByConnectionId.set("conn-integration", {
      source: "file",
      provider: "pinchy",
      id: "/integrations/conn-integration/odooApiKey",
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId);

    const result = await tool.execute("call-1", { model: "sale.order" });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("must be a string");
    expect(text).toContain("#209");
    // Critically: the plugin must not have produced the Python crash text
    // — meaning the request never reached Odoo with the broken payload.
    expect(text).not.toContain("unhashable type");

    // Restore for subsequent tests
    credentialsByConnectionId.set("conn-integration", {
      url: `http://127.0.0.1:${mockOdoo.jsonRpcPort}`,
      db: "testdb",
      uid: 2,
      apiKey: "test-api-key",
    });
  });

  it("surfaces a clear error when Pinchy returns 404 for an unknown connectionId", async () => {
    const tools = createApi({
      [agentId]: { ...agentConfig, connectionId: "unknown-connection-id" },
    });
    const tool = findTool(tools, "odoo_describe_model", agentId);

    const result = await tool.execute("call-1", { model: "sale.order" });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("404");
  });
});

describe("pinchy-odoo mail.activity scheduling against real mock-odoo", () => {
  const activityAgentId = "agent-activity";
  const activityConnectionId = "conn-activity";
  const activityConfig = {
    connectionId: activityConnectionId,
    permissions: {
      "crm.lead": ["read", "create", "write"],
      "mail.activity": ["read", "create", "write"],
    },
    modelNames: { "crm.lead": "Lead/Opportunity", "mail.activity": "Activity" },
  };

  beforeAll(async () => {
    // Reset the store (its defaults now seed crm.lead / mail.activity /
    // ir.model.data) and point this connection at the in-process mock-odoo.
    await fetch(`http://127.0.0.1:${mockOdoo.controlPort}/control/reset`, {
      method: "POST",
    });
    credentialsByConnectionId.set(activityConnectionId, {
      url: `http://127.0.0.1:${mockOdoo.jsonRpcPort}`,
      db: "testdb",
      uid: 2,
      apiKey: "test-api-key",
    });
  });

  function leadRef(id: number, label: string): string {
    return encodeRef({
      integrationType: "odoo",
      connectionId: activityConnectionId,
      model: "crm.lead",
      id,
      label,
    });
  }

  async function activities(): Promise<Array<Record<string, unknown>>> {
    return (await fetch(
      `http://127.0.0.1:${mockOdoo.controlPort}/control/records?model=mail.activity`,
    ).then((r) => r.json())) as Array<Record<string, unknown>>;
  }

  it("GUARD: the mock enforces Odoo's res_id CHECK — an activity with no model link is rejected", async () => {
    const tools = createApi({ [activityAgentId]: activityConfig });
    const tool = findTool(tools, "odoo_create", activityAgentId);
    const result = await tool.execute("c-orphan", {
      model: "mail.activity",
      values: { res_id: 1, summary: "orphan", date_deadline: "2026-06-30" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("not null res_id");
  });

  it("odoo_schedule_activity resolves res_model_id from the target ref and links the activity to the right record", async () => {
    const tools = createApi({ [activityAgentId]: activityConfig });
    const tool = findTool(tools, "odoo_schedule_activity", activityAgentId);
    const result = await tool.execute("c-schedule", {
      target: leadRef(1, "Big Fence Order — Müller GmbH"),
      summary: "Call the customer about the quote",
      dueDate: "2026-06-30",
    });
    expect(result.isError).toBeFalsy();

    const created = (await activities()).find(
      (a) => a.summary === "Call the customer about the quote",
    );
    expect(created).toBeTruthy();
    // res_model_id resolved to the ir.model id for crm.lead (seed id 5)
    expect(created!.res_model_id).toBe(5);
    expect(created!.res_model).toBe("crm.lead");
    expect(created!.res_id).toBe(1);
    // default To-Do activity type resolved via ir.model.data (seed id 1)
    expect(created!.activity_type_id).toBe(1);
    // assignee defaults to the lead's salesperson (seed user 7)
    expect(created!.user_id).toBe(7);
    expect(created!.date_deadline).toBe("2026-06-30");
  });

  it("odoo_schedule_activity accepts an explicit assignee by exact name", async () => {
    const tools = createApi({ [activityAgentId]: activityConfig });
    const tool = findTool(tools, "odoo_schedule_activity", activityAgentId);
    const result = await tool.execute("c-assignee", {
      target: leadRef(1, "Big Fence Order"),
      summary: "Send revised proposal",
      dueDate: "2026-07-01",
      assignee: "Mitch Admin",
    });
    expect(result.isError).toBeFalsy();

    const created = (await activities()).find(
      (a) => a.summary === "Send revised proposal",
    );
    expect(created!.user_id).toBe(2);
  });

  it("odoo_schedule_activity links a lead with no salesperson without forcing a user", async () => {
    const tools = createApi({ [activityAgentId]: activityConfig });
    const tool = findTool(tools, "odoo_schedule_activity", activityAgentId);
    const result = await tool.execute("c-noowner", {
      target: leadRef(2, "Cold inbound — no owner yet"),
      summary: "Qualify this lead",
      dueDate: "2026-07-02",
    });
    expect(result.isError).toBeFalsy();

    const created = (await activities()).find(
      (a) => a.summary === "Qualify this lead",
    );
    expect(created!.res_id).toBe(2);
    expect(created!.user_id).toBeUndefined();
  });

  it("SAFETY-NET: odoo_create on mail.activity with a res_model string (legacy agent path) is translated to res_model_id", async () => {
    const tools = createApi({ [activityAgentId]: activityConfig });
    const tool = findTool(tools, "odoo_create", activityAgentId);
    const result = await tool.execute("c-legacy", {
      model: "mail.activity",
      values: {
        res_model: "crm.lead",
        res_id: 1,
        summary: "Legacy path follow-up",
        date_deadline: "2026-07-03",
      },
    });
    expect(result.isError).toBeFalsy();

    const created = (await activities()).find(
      (a) => a.summary === "Legacy path follow-up",
    );
    expect(created!.res_model_id).toBe(5);
    expect(created!.res_model).toBe("crm.lead");
    expect(created!.res_id).toBe(1);
  });

  it("odoo_complete_activity marks a scheduled activity done (removes it)", async () => {
    const tools = createApi({ [activityAgentId]: activityConfig });
    const schedule = findTool(tools, "odoo_schedule_activity", activityAgentId);
    const complete = findTool(tools, "odoo_complete_activity", activityAgentId);

    const scheduled = await schedule.execute("c-sched-complete", {
      target: leadRef(1, "Big Fence Order"),
      summary: "Activity to complete",
      dueDate: "2026-07-10",
    });
    const { _pinchy_ref } = JSON.parse(scheduled.content[0].text) as {
      _pinchy_ref: string;
    };
    expect(
      (await activities()).some((a) => a.summary === "Activity to complete"),
    ).toBe(true);

    const result = await complete.execute("c-complete", {
      target: _pinchy_ref,
      feedback: "Spoke to the customer, quote accepted",
    });
    expect(result.isError).toBeFalsy();

    // action_feedback marks done → the activity is gone from the open list.
    expect(
      (await activities()).some((a) => a.summary === "Activity to complete"),
    ).toBe(false);
  });

  it("odoo_reschedule_activity updates the deadline and reassigns the activity", async () => {
    const tools = createApi({ [activityAgentId]: activityConfig });
    const schedule = findTool(tools, "odoo_schedule_activity", activityAgentId);
    const reschedule = findTool(
      tools,
      "odoo_reschedule_activity",
      activityAgentId,
    );

    const scheduled = await schedule.execute("c-sched-resched", {
      target: leadRef(1, "Big Fence Order"),
      summary: "Activity to reschedule",
      dueDate: "2026-07-11",
    });
    const { id, _pinchy_ref } = JSON.parse(scheduled.content[0].text) as {
      id: number;
      _pinchy_ref: string;
    };

    const result = await reschedule.execute("c-resched", {
      target: _pinchy_ref,
      dueDate: "2026-08-01",
      assignee: "Mitch Admin",
    });
    expect(result.isError).toBeFalsy();

    const updated = (await activities()).find((a) => a.id === id);
    expect(updated!.date_deadline).toBe("2026-08-01");
    expect(updated!.user_id).toBe(2);
  });
});

describe("pinchy-odoo record-action tools against real mock-odoo", () => {
  const actionAgentId = "agent-actions";
  const actionConnectionId = "conn-actions";
  const actionConfig = {
    connectionId: actionConnectionId,
    permissions: {
      "sale.order": ["read", "write"],
      "stock.picking": ["read", "write"],
      "hr.expense.sheet": ["read", "write"],
    },
  };

  beforeAll(async () => {
    await fetch(`http://127.0.0.1:${mockOdoo.controlPort}/control/reset`, {
      method: "POST",
    });
    credentialsByConnectionId.set(actionConnectionId, {
      url: `http://127.0.0.1:${mockOdoo.jsonRpcPort}`,
      db: "testdb",
      uid: 2,
      apiKey: "test-api-key",
    });
  });

  function ref(model: string, id: number): string {
    return encodeRef({
      integrationType: "odoo",
      connectionId: actionConnectionId,
      model,
      id,
      label: model,
    });
  }

  it("odoo_confirm_order calls action_confirm and reports completed", async () => {
    const tools = createApi({ [actionAgentId]: actionConfig });
    const tool = findTool(tools, "odoo_confirm_order", actionAgentId);
    const result = await tool.execute("c-confirm", {
      target: ref("sale.order", 1),
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).completed).toBe(true);
  });

  it("odoo_validate_picking hands off (Variant A) when Odoo returns a backorder wizard", async () => {
    await fetch(
      `http://127.0.0.1:${mockOdoo.controlPort}/control/method-response`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "stock.picking",
          method: "button_validate",
          response: {
            type: "ir.actions.act_window",
            res_model: "stock.backorder.confirmation",
          },
        }),
      },
    );
    const tools = createApi({ [actionAgentId]: actionConfig });
    const tool = findTool(tools, "odoo_validate_picking", actionAgentId);
    const result = await tool.execute("c-validate", {
      target: ref("stock.picking", 5),
    });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.completed).toBe(false);
    expect(data.needsHuman).toBe(true);
    expect(data.pendingStep).toBe("stock.backorder.confirmation");
  });

  it("odoo_set_approval refuses an expense sheet end-to-end", async () => {
    const tools = createApi({ [actionAgentId]: actionConfig });
    const tool = findTool(tools, "odoo_set_approval", actionAgentId);
    const result = await tool.execute("c-refuse", {
      target: ref("hr.expense.sheet", 9),
      decision: "refuse",
      reason: "Over budget",
    });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(result.content[0].text).completed).toBe(true);
  });
});

// Production regression: the Penny agent (Helmcraft bookkeeping) could not
// create an opening-balance account.move because `journal_id` would not
// resolve — two companies share a "Miscellaneous Operations" / SONST journal,
// the name/code lookup collided, and the bare `_pinchy_ref` the agent copied
// from odoo_read fell through to a name lookup that never matches. These
// tests exercise the full chain plugin → Pinchy credentials → odoo-node →
// mock-odoo against the seeded multi-company journals.
describe("pinchy-odoo multi-company journal resolution (bare ref + scoped lookup)", () => {
  const accountingAgentId = "agent-accounting";
  const accountingConnectionId = "conn-accounting";
  const accountingConfig = {
    connectionId: accountingConnectionId,
    permissions: {
      "res.company": ["read"],
      "account.journal": ["read"],
      "account.move": ["read", "create"],
    },
  };

  beforeAll(async () => {
    await fetch(`http://127.0.0.1:${mockOdoo.controlPort}/control/reset`, {
      method: "POST",
    });
    credentialsByConnectionId.set(accountingConnectionId, {
      url: `http://127.0.0.1:${mockOdoo.jsonRpcPort}`,
      db: "testdb",
      uid: 2,
      apiKey: "test-api-key",
    });
  });

  function ref(model: string, id: number, label: string, companyId?: number, companyLabel?: string): string {
    return encodeRef({
      integrationType: "odoo",
      connectionId: accountingConnectionId,
      model,
      id,
      label,
      ...(companyId !== undefined && companyLabel !== undefined
        ? { companyId, companyLabel }
        : {}),
    });
  }

  it("creates an account.move with a bare _pinchy_ref journal_id (the form odoo_read emits)", async () => {
    const tools = createApi({ [accountingAgentId]: accountingConfig });
    const readTool = findTool(tools, "odoo_read", accountingAgentId);
    const createTool = findTool(tools, "odoo_create", accountingAgentId);

    // 1. Read the Helmcraft SONST journal to obtain its `_pinchy_ref` — the
    //    bare-string form the agent copies verbatim into the next call.
    const readResult = await readTool.execute("read-journal", {
      model: "account.journal",
      filters: [["id", "=", 17]],
      fields: ["name", "company_id"],
    });
    expect(readResult.isError).toBeFalsy();
    const readData = JSON.parse(readResult.content[0].text);
    const journal = readData.records[0];
    expect(journal._pinchy_ref).toMatch(/^pinchy_ref:v1:/);

    // 2. Create the move with the bare ref as journal_id (Layer 1) and a
    //    res.company ref as company_id.
    const companyRef = ref("res.company", 1, "Helmcraft GmbH", 1, "Helmcraft GmbH");
    const createResult = await createTool.execute("create-move-bare-ref", {
      model: "account.move",
      values: {
        ref: "Eröffnung 3530 per 01.01.2026",
        date: "2026-01-01",
        move_type: "entry",
        company_id: { ref: companyRef },
        journal_id: journal._pinchy_ref, // bare string — the production form
      },
    });

    expect(createResult.isError).toBeFalsy();
    const { id } = JSON.parse(createResult.content[0].text) as { id: number };
    const moves = (await fetch(
      `http://127.0.0.1:${mockOdoo.controlPort}/control/records?model=account.move`,
    ).then((res) => res.json())) as Array<Record<string, unknown>>;
    expect(moves.find((m) => m.id === id)).toMatchObject({
      journal_id: 17,
      company_id: 1,
      ref: "Eröffnung 3530 per 01.01.2026",
    });
  });

  it("scopes a journal name lookup by company_id, resolving the multi-company collision (Layer 2)", async () => {
    const tools = createApi({ [accountingAgentId]: accountingConfig });
    const createTool = findTool(tools, "odoo_create", accountingAgentId);

    const companyRef = ref("res.company", 1, "Helmcraft GmbH", 1, "Helmcraft GmbH");
    // journal_id passed as a display NAME (not a ref) — ambiguous across the
    // two companies without the company_id scope. With Layer 2 the lookup is
    // constrained to company 1 and resolves to journal 17.
    const createResult = await createTool.execute("create-move-scoped-name", {
      model: "account.move",
      values: {
        ref: "Sonstbuchung per 01.01.2026",
        date: "2026-01-01",
        move_type: "entry",
        company_id: { ref: companyRef },
        journal_id: "Miscellaneous Operations",
      },
    });

    expect(createResult.isError).toBeFalsy();
    const { id } = JSON.parse(createResult.content[0].text) as { id: number };
    const moves = (await fetch(
      `http://127.0.0.1:${mockOdoo.controlPort}/control/records?model=account.move`,
    ).then((res) => res.json())) as Array<Record<string, unknown>>;
    expect(moves.find((m) => m.id === id)).toMatchObject({
      journal_id: 17,
      company_id: 1,
    });
  });

  it("still rejects a bare ref pointing at the wrong company's journal (cross-company guard)", async () => {
    const tools = createApi({ [accountingAgentId]: accountingConfig });
    const createTool = findTool(tools, "odoo_create", accountingAgentId);

    const companyRefA = ref("res.company", 1, "Helmcraft GmbH", 1, "Helmcraft GmbH");
    // Bare ref for company 2's journal while company_id points at company 1.
    const journalRefB = ref(
      "account.journal",
      24,
      "Miscellaneous Operations [Clemens Helm]",
      2,
      "Clemens Helm",
    );
    const createResult = await createTool.execute("create-move-xc", {
      model: "account.move",
      values: {
        ref: "should be rejected",
        date: "2026-01-01",
        move_type: "entry",
        company_id: { ref: companyRefA },
        journal_id: journalRefB,
      },
    });

    expect(createResult.isError).toBe(true);
    expect(createResult.content[0].text).toMatch(/cross-company/i);
    const moves = (await fetch(
      `http://127.0.0.1:${mockOdoo.controlPort}/control/records?model=account.move`,
    ).then((res) => res.json())) as Array<Record<string, unknown>>;
    expect(moves.some((m) => m.ref === "should be rejected")).toBe(false);
  });
});
