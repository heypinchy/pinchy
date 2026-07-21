// @vitest-environment node
//
// #720: plugin-side write verification (read-after-write). The plugin reads the
// record back before reporting success, turning a silent no-op backend (Eval-v1
// silent-failure scenario: id returned, nothing persisted) into a hard, visible
// error instead of a false success.
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentOdooConfig, OdooField } from "../index";

const mockSearchRead = vi.fn();
const mockSearchCount = vi.fn();
const mockReadGroup = vi.fn();
const mockCreate = vi.fn();
const mockWrite = vi.fn();
const mockUnlink = vi.fn();
const mockFields = vi.fn();
const mockCallMethod = vi.fn();

vi.mock("odoo-node", () => {
  const MockOdooClient = vi.fn(function (this: Record<string, unknown>) {
    this.searchRead = mockSearchRead;
    this.searchCount = mockSearchCount;
    this.readGroup = mockReadGroup;
    this.create = mockCreate;
    this.write = mockWrite;
    this.unlink = mockUnlink;
    this.fields = mockFields;
    this.callMethod = mockCallMethod;
  });
  return { OdooClient: MockOdooClient };
});

vi.mock("../io", () => ({ readFile: vi.fn(), stat: vi.fn() }));

import plugin, {
  isVerifiedModel,
  isVerbatimScalarField,
  verbatimFieldsToVerify,
  findVerbatimMismatches,
} from "../index";

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({
    type: "odoo",
    credentials: { url: "http://odoo-test:8069", db: "testdb", uid: 2, apiKey: "k" },
  }),
}));
globalThis.fetch = fetchMock as unknown as typeof fetch;

interface AgentTool {
  name: string;
  execute: (
    id: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: { error?: string; verified?: boolean };
  }>;
}

function createApi(agentConfigs: Record<string, AgentOdooConfig> = {}) {
  const tools: Array<{ factory: (ctx: { agentId?: string }) => AgentTool | null; name: string }> =
    [];
  const api = {
    pluginConfig: {
      apiBaseUrl: "http://pinchy-test:7777",
      gatewayToken: "test-gateway-token",
      agents: agentConfigs,
    },
    registerTool: (
      factory: (ctx: { agentId?: string }) => AgentTool | null,
      opts?: { name?: string }
    ) => {
      tools.push({ factory, name: opts?.name ?? "" });
    },
  };
  plugin.register(api as never);
  return tools;
}

function findTool(tools: ReturnType<typeof createApi>, name: string, agentId?: string): AgentTool {
  const entry = tools.find((t) => t.name === name)!;
  return entry.factory({ agentId })!;
}

const agentId = "agent-1";
const CONN = "conn-test-1";

// account.move schema the mock returns during m2o normalization. Covers a
// verbatim char (ref), a selection (move_type), a many2one (partner_id, must be
// EXCLUDED from comparison), and a monetary/float (amount_total, EXCLUDED).
const MOVE_FIELDS = [
  { name: "ref", string: "Reference", type: "char" },
  {
    name: "move_type",
    string: "Type",
    type: "selection",
    selection: [
      ["entry", "Journal Entry"],
      ["out_invoice", "Customer Invoice"],
      ["in_invoice", "Vendor Bill"],
    ],
  },
  { name: "partner_id", string: "Partner", type: "many2one", relation: "res.partner" },
  { name: "amount_total", string: "Total", type: "monetary" },
];

function moveConfig(
  permissions: Record<string, string[]> = { "account.move": ["read", "create", "write"] }
): AgentOdooConfig {
  return { connectionId: CONN, permissions } as AgentOdooConfig;
}

function empty() {
  return { records: [], total: 0, limit: 1000, offset: 0 };
}
function records(recs: Array<Record<string, unknown>>) {
  return { records: recs, total: recs.length, limit: 1000, offset: 0 };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  mockFields.mockResolvedValue(MOVE_FIELDS);
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------
describe("isVerifiedModel", () => {
  it("covers account.move and its line model", () => {
    expect(isVerifiedModel("account.move")).toBe(true);
    expect(isVerifiedModel("account.move.line")).toBe(true);
  });
  it("does not cover other models (scoped start)", () => {
    expect(isVerifiedModel("res.partner")).toBe(false);
    expect(isVerifiedModel("sale.order")).toBe(false);
  });
});

describe("isVerbatimScalarField", () => {
  it("accepts verbatim scalar types Odoo stores unchanged", () => {
    for (const type of ["char", "text", "boolean", "date", "selection", "integer"]) {
      expect(isVerbatimScalarField({ name: "f", type })).toBe(true);
    }
  });
  it("rejects types Odoo may legitimately transform (avoids false-failures)", () => {
    for (const type of ["float", "monetary", "datetime", "many2one", "one2many", "many2many"]) {
      expect(isVerbatimScalarField({ name: "f", type, relation: "x" })).toBe(false);
    }
  });
  it("rejects readonly/computed fields (the server owns them)", () => {
    expect(isVerbatimScalarField({ name: "name", type: "char", readonly: true })).toBe(false);
  });
});

describe("verbatimFieldsToVerify", () => {
  const fields: OdooField[] = MOVE_FIELDS as OdooField[];
  it("returns only submitted fields that map to a verbatim scalar", () => {
    const out = verbatimFieldsToVerify(fields, {
      ref: "INV-1",
      move_type: "in_invoice",
      partner_id: 5, // many2one -> excluded
      amount_total: 100, // monetary -> excluded
      unknown_field: "x", // not in schema -> excluded
    });
    expect(out.map((f) => f.name).sort()).toEqual(["move_type", "ref"]);
  });
  it("returns nothing when no submitted field is a verbatim scalar", () => {
    expect(verbatimFieldsToVerify(fields, { partner_id: 5, amount_total: 9 })).toEqual([]);
  });
});

describe("findVerbatimMismatches", () => {
  const fields: OdooField[] = MOVE_FIELDS as OdooField[];
  it("flags a submitted verbatim scalar that read back different", () => {
    const out = findVerbatimMismatches(fields, { ref: "INV-1" }, { ref: "SOMETHING-ELSE" });
    expect(out).toEqual([{ field: "ref", expected: "INV-1", actual: "SOMETHING-ELSE" }]);
  });
  it("passes when the read-back value matches", () => {
    expect(findVerbatimMismatches(fields, { ref: "INV-1" }, { ref: "INV-1" })).toEqual([]);
  });
  it("flags a missing value (Odoo returned false / dropped the field)", () => {
    const out = findVerbatimMismatches(fields, { ref: "INV-1" }, { ref: false });
    expect(out).toEqual([{ field: "ref", expected: "INV-1", actual: false }]);
  });
  it("ignores relational and monetary fields even when they differ", () => {
    expect(
      findVerbatimMismatches(
        fields,
        { partner_id: 5, amount_total: 100 },
        { partner_id: [7, "Other"], amount_total: 99.5 }
      )
    ).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// odoo_create verification
// ---------------------------------------------------------------------------
describe("odoo_create verification", () => {
  it("reads the record back and reports verified:true on a matching create", async () => {
    mockCreate.mockResolvedValue(42);
    // dup-guard read (ref set) → no dup; then verification read → the record.
    mockSearchRead
      .mockResolvedValueOnce(empty())
      .mockResolvedValueOnce(records([{ id: 42, ref: "INV-1", move_type: "in_invoice" }]));

    const tool = findTool(createApi({ [agentId]: moveConfig() }), "odoo_create", agentId);
    const res = await tool.execute("c1", {
      model: "account.move",
      values: { ref: "INV-1", move_type: "in_invoice" },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].text);
    expect(data.id).toBe(42);
    expect(data.verified).toBe(true);
    expect(res.details?.verified).toBe(true);
    // The verification read really happened.
    expect(mockSearchRead).toHaveBeenCalledWith(
      "account.move",
      [["id", "=", 42]],
      expect.objectContaining({ fields: expect.arrayContaining(["id", "ref", "move_type"]) })
    );
  });

  it("turns a silent no-op (id returned, record not persisted) into a hard error", async () => {
    mockCreate.mockResolvedValue(42);
    mockSearchRead
      .mockResolvedValueOnce(empty()) // dup-guard
      .mockResolvedValueOnce(empty()); // verification read: record MISSING

    const tool = findTool(createApi({ [agentId]: moveConfig() }), "odoo_create", agentId);
    const res = await tool.execute("c1", {
      model: "account.move",
      values: { ref: "INV-1", move_type: "in_invoice" },
    });

    expect(res.isError).toBe(true);
    expect(res.details?.verified).toBe(false);
    // Audit failure signal is present.
    expect(res.details?.error).toBeTruthy();
    expect(res.content[0].text.toLowerCase()).toContain("could not be read back");
  });

  it("fails when a written verbatim scalar reads back different", async () => {
    mockCreate.mockResolvedValue(42);
    mockSearchRead
      .mockResolvedValueOnce(empty()) // dup-guard
      .mockResolvedValueOnce(records([{ id: 42, ref: "WRONG", move_type: "in_invoice" }]));

    const tool = findTool(createApi({ [agentId]: moveConfig() }), "odoo_create", agentId);
    const res = await tool.execute("c1", {
      model: "account.move",
      values: { ref: "INV-1", move_type: "in_invoice" },
    });

    expect(res.isError).toBe(true);
    expect(res.details?.verified).toBe(false);
    expect(res.content[0].text).toContain("ref");
  });

  it("does not verify non-covered models (no read-back, no verified flag)", async () => {
    mockCreate.mockResolvedValue(7);
    const cfg = { connectionId: CONN, permissions: { "res.partner": ["create", "read"] } };
    const tool = findTool(createApi({ [agentId]: cfg as AgentOdooConfig }), "odoo_create", agentId);
    const res = await tool.execute("c1", {
      model: "res.partner",
      values: { name: "Acme" },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].text);
    expect(data.id).toBe(7);
    expect(data.verified).toBeUndefined();
    expect(res.details?.verified).toBeUndefined();
    // No verification read against res.partner by id.
    expect(mockSearchRead).not.toHaveBeenCalled();
  });

  it("skips verification (no false claim) when the agent lacks read permission", async () => {
    mockCreate.mockResolvedValue(42);
    const tool = findTool(
      createApi({ [agentId]: moveConfig({ "account.move": ["create"] }) }),
      "odoo_create",
      agentId
    );
    const res = await tool.execute("c1", {
      model: "account.move",
      values: { ref: "INV-1", move_type: "in_invoice" },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].text);
    expect(data.id).toBe(42);
    expect(data.verified).toBeUndefined();
    // Without read permission there is no verification read at all.
    expect(mockSearchRead).not.toHaveBeenCalled();
  });

  it("degrades to unverified success (no false-fail) when the verification read throws", async () => {
    mockCreate.mockResolvedValue(42);
    mockSearchRead
      .mockResolvedValueOnce(empty()) // dup-guard
      .mockRejectedValueOnce(new Error("network blip")); // verification read fails

    const tool = findTool(createApi({ [agentId]: moveConfig() }), "odoo_create", agentId);
    const res = await tool.execute("c1", {
      model: "account.move",
      values: { ref: "INV-1", move_type: "in_invoice" },
    });

    // The create DID happen — do not report failure and risk a duplicate retry.
    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].text);
    expect(data.id).toBe(42);
    expect(data.verified).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// odoo_write verification
// ---------------------------------------------------------------------------
describe("odoo_write verification", () => {
  it("reads back and reports verified:true when the written scalar matches", async () => {
    mockWrite.mockResolvedValue(true);
    mockSearchRead.mockResolvedValueOnce(records([{ id: 42, ref: "INV-2" }]));

    const tool = findTool(createApi({ [agentId]: moveConfig() }), "odoo_write", agentId);
    const res = await tool.execute("w1", {
      model: "account.move",
      ids: [42],
      values: { ref: "INV-2" },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].text);
    expect(data.success).toBe(true);
    expect(data.verified).toBe(true);
    expect(res.details?.verified).toBe(true);
  });

  it("fails when Odoo reports success but the value did not persist", async () => {
    mockWrite.mockResolvedValue(true);
    mockSearchRead.mockResolvedValueOnce(records([{ id: 42, ref: "OLD-VALUE" }]));

    const tool = findTool(createApi({ [agentId]: moveConfig() }), "odoo_write", agentId);
    const res = await tool.execute("w1", {
      model: "account.move",
      ids: [42],
      values: { ref: "INV-2" },
    });

    expect(res.isError).toBe(true);
    expect(res.details?.verified).toBe(false);
    expect(res.content[0].text).toContain("ref");
  });

  it("does not verify non-covered models", async () => {
    mockWrite.mockResolvedValue(true);
    const cfg = { connectionId: CONN, permissions: { "res.partner": ["write", "read"] } };
    const tool = findTool(createApi({ [agentId]: cfg as AgentOdooConfig }), "odoo_write", agentId);
    const res = await tool.execute("w1", {
      model: "res.partner",
      ids: [7],
      values: { name: "New Name" },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].text);
    expect(data.success).toBe(true);
    expect(data.verified).toBeUndefined();
    expect(mockSearchRead).not.toHaveBeenCalled();
  });
});
