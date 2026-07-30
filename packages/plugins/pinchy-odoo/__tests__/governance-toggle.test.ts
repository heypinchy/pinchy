// @vitest-environment node
//
// #723: eval-only governance toggle. The pinchy-odoo write guards (duplicate
// guard #721 + read-back verification #720) are DEFAULT-ON in production. The
// governed-tools comparison sweep needs to run the SAME scenarios with the
// guards turned OFF (the ungoverned arm) so the before/after delta isolates the
// guards' effect. The switch is the env var PINCHY_ODOO_GOVERNANCE ("enforced"
// default | "off"), read by the plugin at the two guard decision points in
// odoo_create. It is stack-level, eval-only, never emitted into product config,
// and never settable from the product UI — see
// docs/plans/2026-07-24-governed-tools-comparison-sweep-design.md.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentOdooConfig } from "../index";

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

import plugin, { governanceEnforced } from "../index";

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

const MOVE_FIELDS = [
  {
    name: "move_type",
    string: "Type",
    type: "selection",
    selection: [
      ["entry", "Journal Entry"],
      ["out_invoice", "Customer Invoice"],
      ["in_invoice", "Vendor Bill"],
      ["in_refund", "Vendor Credit Note"],
    ],
  },
  { name: "ref", string: "Reference", type: "char" },
  { name: "partner_id", string: "Partner", type: "many2one", relation: "res.partner" },
];

function moveConfig(): AgentOdooConfig {
  return {
    connectionId: CONN,
    permissions: { "account.move": ["read", "create"] },
  } as AgentOdooConfig;
}

const EXISTING_BILL = {
  id: 39,
  name: "BILL/2026/0039",
  state: "posted",
  amount_total: 1234.56,
  invoice_date: "2026-06-01",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  mockFields.mockResolvedValue(MOVE_FIELDS);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

// ---------------------------------------------------------------------------
// Pure helper: governanceEnforced()
// ---------------------------------------------------------------------------
describe("governanceEnforced", () => {
  it("defaults to enforced when PINCHY_ODOO_GOVERNANCE is unset", () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "");
    expect(governanceEnforced()).toBe(true);
  });

  it('is enforced when explicitly "enforced"', () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "enforced");
    expect(governanceEnforced()).toBe(true);
  });

  it('is OFF only for the exact literal "off" (case-insensitive, trimmed)', () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "off");
    expect(governanceEnforced()).toBe(false);
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "OFF");
    expect(governanceEnforced()).toBe(false);
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "  off  ");
    expect(governanceEnforced()).toBe(false);
  });

  it("fails safe to enforced on any unrecognized value", () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "disabled");
    expect(governanceEnforced()).toBe(true);
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "false");
    expect(governanceEnforced()).toBe(true);
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "0");
    expect(governanceEnforced()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// odoo_create with governance OFF: both guards are skipped
// ---------------------------------------------------------------------------
describe("odoo_create with PINCHY_ODOO_GOVERNANCE=off (ungoverned arm)", () => {
  it("does NOT block a duplicate vendor bill — the create reaches Odoo", async () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "off");
    // If the guard were active this hit would block. Ungoverned = it must not
    // even be consulted; the create goes straight through.
    mockCreate.mockResolvedValue(40);

    const tool = findTool(createApi({ [agentId]: moveConfig() }), "odoo_create", agentId);
    const res = await tool.execute("call-dup", {
      model: "account.move",
      values: { move_type: "in_invoice", ref: "083000981540" },
    });

    expect(res.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledTimes(1);
    const data = JSON.parse(res.content[0].text);
    expect(data.id).toBe(40);
  });

  it("does NOT read back — a silent no-op backend reports success, not a hard error", async () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "off");
    mockCreate.mockResolvedValue(999);
    // Read-back, if it ran, would find nothing and hard-error (#720). Ungoverned
    // = no read-back, so the silent no-op is reported as an unremarkable success
    // (this is exactly the failure the guard was built to catch).
    mockSearchRead.mockResolvedValue({ records: [], total: 0, limit: 1, offset: 0 });

    const tool = findTool(createApi({ [agentId]: moveConfig() }), "odoo_create", agentId);
    const res = await tool.execute("call-silent", {
      model: "account.move",
      values: { move_type: "in_invoice", ref: "INV-NEW" },
    });

    expect(res.isError).toBeFalsy();
    const data = JSON.parse(res.content[0].text);
    expect(data.id).toBe(999);
    // No read-back happened, so no verified flag is claimed either way.
    expect(data.verified).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Ops safety: register() warns loudly when governance is off so an operator
// can never mis-attribute an ungoverned run (CISO signal in OpenClaw stdout).
// ---------------------------------------------------------------------------
describe("register() governance warning", () => {
  it("warns once when PINCHY_ODOO_GOVERNANCE=off", () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "off");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createApi({ [agentId]: moveConfig() });
    const governanceWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).toLowerCase().includes("governance")
    );
    expect(governanceWarnings.length).toBe(1);
    expect(String(governanceWarnings[0][0]).toLowerCase()).toContain("off");
    warn.mockRestore();
  });

  it("does not warn about governance when enforced (default)", () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    createApi({ [agentId]: moveConfig() });
    const governanceWarnings = warn.mock.calls.filter((c) =>
      String(c[0]).toLowerCase().includes("governance")
    );
    expect(governanceWarnings.length).toBe(0);
    warn.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Guardrail: default (enforced) still blocks — the toggle is opt-in only
// ---------------------------------------------------------------------------
describe("odoo_create governed by default (no env) still enforces the guards", () => {
  it("blocks a duplicate vendor bill when PINCHY_ODOO_GOVERNANCE is unset", async () => {
    vi.stubEnv("PINCHY_ODOO_GOVERNANCE", "");
    mockSearchRead.mockResolvedValue({
      records: [EXISTING_BILL],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const tool = findTool(createApi({ [agentId]: moveConfig() }), "odoo_create", agentId);
    const res = await tool.execute("call-dup", {
      model: "account.move",
      values: { move_type: "in_invoice", ref: "083000981540" },
    });

    expect(res.isError).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(res.content[0].text).toMatch(/allow_duplicate/);
  });
});
