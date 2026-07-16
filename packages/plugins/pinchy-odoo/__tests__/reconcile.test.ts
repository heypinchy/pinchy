// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
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

import { encodeRef } from "../integration-ref";
import plugin from "../index";

// The plugin lazily fetches Odoo credentials from the Pinchy API (Pattern B),
// so the tool never runs without a stubbed credentials endpoint.
const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({
    type: "odoo",
    credentials: {
      url: "http://odoo-test:8069",
      db: "testdb",
      uid: 2,
      apiKey: "test-api-key",
    },
  }),
}));
globalThis.fetch = fetchMock as unknown as typeof fetch;

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    id: string,
    params: Record<string, unknown>,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
  }>;
}

function createApi(agentConfigs: Record<string, AgentOdooConfig> = {}) {
  const tools: Array<{
    factory: (ctx: { agentId?: string }) => AgentTool | null;
    name: string;
  }> = [];
  const api = {
    pluginConfig: {
      apiBaseUrl: "http://pinchy-test:7777",
      gatewayToken: "test-gateway-token",
      agents: agentConfigs,
    },
    registerTool: (
      factory: (ctx: { agentId?: string }) => AgentTool | null,
      opts?: { name?: string },
    ) => {
      tools.push({ factory, name: opts?.name ?? "" });
    },
  };
  plugin.register(api as never);
  return tools;
}

function findTool(
  tools: ReturnType<typeof createApi>,
  name: string,
  agentId?: string,
): AgentTool | null {
  const entry = tools.find((t) => t.name === name);
  if (!entry) return null;
  return entry.factory({ agentId });
}

const agentId = "agent-1";
const CONN = "conn-test-1";

const FULL_PERMS = {
  "account.move": ["read", "write"],
  "account.move.line": ["read", "write"],
  "account.bank.statement.line": ["read", "write"],
  "account.payment": ["read"],
  "account.journal": ["read"],
};

function cfg(
  permissions: Record<string, string[]> = FULL_PERMS,
): AgentOdooConfig {
  return { connectionId: CONN, permissions } as AgentOdooConfig;
}

function ref(model: string, id: number, label = "x"): string {
  return encodeRef({
    integrationType: "odoo",
    connectionId: CONN,
    model,
    id,
    label,
  });
}

// ---------------------------------------------------------------------------
// Fixture mirroring the real Odoo 19 shape verified on the demo instance:
// statement line 5 (-622.27) against posted bill 9 (residual 622.27).
//   liquidity line: Bank (47)              credit 622.27
//   suspense line:  Bank Suspense (48)     debit  622.27
//   bill line:      Account Payable (15)   credit 622.27
// ---------------------------------------------------------------------------
const INVOICE_ID = 9;
const ST_LINE_ID = 5;
const ST_MOVE_ID = 23;
const JOURNAL_ID = 6;
const BANK_ACC = 47;
const SUSPENSE_ACC = 48;
const PAYABLE_ACC = 15;
const PARTNER = 10;

const INVOICE_ROW = {
  id: INVOICE_ID,
  state: "posted",
  payment_state: "not_paid",
  amount_residual: 622.27,
  company_id: [1, "Crabon Bikes"],
  partner_id: [PARTNER, "Gemini Furniture"],
  name: "BILL/2026/04/0001",
};
const INVOICE_LINE_ROW = {
  id: 47,
  account_id: [PAYABLE_ACC, "Account Payable"],
  debit: 0,
  credit: 622.27,
  amount_currency: -622.27,
  reconciled: false,
};
const ST_LINE_ROW = {
  id: ST_LINE_ID,
  move_id: [ST_MOVE_ID, "BNK1/2026/00005"],
  journal_id: [JOURNAL_ID, "Bank"],
  is_reconciled: false,
  company_id: [1, "Crabon Bikes"],
  partner_id: [PARTNER, "Gemini Furniture"],
  payment_ref: "BILL/2024/01/0001",
  amount: -622.27,
};
const JOURNAL_ROW = {
  id: JOURNAL_ID,
  default_account_id: [BANK_ACC, "Bank"],
  suspense_account_id: [SUSPENSE_ACC, "Bank Suspense Account"],
};
const ST_MOVE_LINES = [
  {
    id: 63,
    account_id: [BANK_ACC, "Bank"],
    debit: 0,
    credit: 622.27,
    amount_currency: -622.27,
    partner_id: [PARTNER, "Gemini Furniture"],
    name: "BILL/2024/01/0001",
  },
  {
    id: 64,
    account_id: [SUSPENSE_ACC, "Bank Suspense Account"],
    debit: 622.27,
    credit: 0,
    amount_currency: 622.27,
    partner_id: [PARTNER, "Gemini Furniture"],
    name: "BILL/2024/01/0001",
  },
];

/** Pulls the value of a `[field, "=", value]` leaf out of an Odoo domain. */
function domainValue(domain: unknown, field: string): unknown {
  if (!Array.isArray(domain)) return undefined;
  for (const leaf of domain) {
    if (Array.isArray(leaf) && leaf[0] === field && leaf[1] === "=") {
      return leaf[2];
    }
  }
  return undefined;
}

/**
 * Routes searchRead by model and domain rather than by call order, so a test
 * can bend one leg of the fixture without depending on how many reads the
 * implementation happens to make. Reads issued after the first write are
 * treated as the post-reconcile read-back.
 */
function stubReads(
  overrides: {
    invoice?: Record<string, unknown>;
    invoiceLines?: Array<Record<string, unknown>>;
    stLine?: Record<string, unknown>;
    stMoveLines?: Array<Record<string, unknown>>;
    payment?: Record<string, unknown>;
    paymentLines?: Array<Record<string, unknown>>;
    newCounterpartLines?: Array<Record<string, unknown>>;
    readBackStLine?: Record<string, unknown>;
    readBackInvoice?: Record<string, unknown>;
  } = {},
) {
  const mutated = () => mockCallMethod.mock.calls.length > 0;

  mockSearchRead.mockImplementation((model: string, domain: unknown) => {
    switch (model) {
      case "account.move":
        return Promise.resolve({
          records: [
            mutated()
              ? (overrides.readBackInvoice ?? {
                  ...INVOICE_ROW,
                  payment_state: "paid",
                  amount_residual: 0,
                })
              : (overrides.invoice ?? INVOICE_ROW),
          ],
        });

      case "account.move.line": {
        const moveId = domainValue(domain, "move_id");
        if (moveId === INVOICE_ID) {
          return Promise.resolve({
            records: overrides.invoiceLines ?? [INVOICE_LINE_ROW],
          });
        }
        if (moveId === PAYMENT_MOVE_ID) {
          return Promise.resolve({
            records:
              overrides.paymentLines ??
              [{ id: 110, account_id: [PAYABLE_ACC, "Account Payable"] }],
          });
        }
        if (moveId === ST_MOVE_ID) {
          // Before the rewrite: the original liquidity + suspense pair.
          // After it: the freshly created payable counterpart.
          if (mutated()) {
            return Promise.resolve({
              records:
                overrides.newCounterpartLines ??
                [{ id: 102, account_id: [PAYABLE_ACC, "Account Payable"] }],
            });
          }
          return Promise.resolve({
            records: overrides.stMoveLines ?? ST_MOVE_LINES,
          });
        }
        return Promise.resolve({ records: [] });
      }

      case "account.bank.statement.line":
        return Promise.resolve({
          records: [
            mutated()
              ? (overrides.readBackStLine ?? {
                  ...ST_LINE_ROW,
                  is_reconciled: true,
                })
              : (overrides.stLine ?? ST_LINE_ROW),
          ],
        });

      case "account.journal":
        return Promise.resolve({ records: [JOURNAL_ROW] });

      case "account.payment":
        return Promise.resolve({ records: [overrides.payment ?? PAYMENT_ROW] });

      default:
        return Promise.resolve({ records: [] });
    }
  });
}

const PAYMENT_ID = 1;
const PAYMENT_MOVE_ID = 44;
const PAYMENT_ROW = {
  id: PAYMENT_ID,
  move_id: [PAYMENT_MOVE_ID, "PBNK1/2026/00001"],
  state: "in_process",
  company_id: [1, "Crabon Bikes"],
  partner_id: [PARTNER, "Gemini Furniture"],
  amount: 622.27,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
});

describe("odoo_reconcile — registration", () => {
  it("is registered", () => {
    expect(createApi({ [agentId]: cfg() }).map((t) => t.name)).toContain(
      "odoo_reconcile",
    );
  });

  it("is not offered to an agent without an Odoo config", () => {
    const tools = createApi({});
    // Guard against a vacuous pass: the tool must be registered, and the
    // factory must be what withholds it from an unconfigured agent.
    expect(tools.map((t) => t.name)).toContain("odoo_reconcile");
    expect(findTool(tools, "odoo_reconcile", agentId)).toBeNull();
  });
});

describe("odoo_reconcile — bank transaction against a posted bill", () => {
  it("replaces the suspense counterpart, reconciles, and confirms via read-back", async () => {
    stubReads();
    mockCallMethod.mockResolvedValue(undefined);
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;

    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });

    expect(result.isError).toBeFalsy();

    // Step 1: the statement move is rewritten — suspense line cleared, a
    // counterpart on the bill's payable account created, liquidity preserved.
    const writeCall = mockCallMethod.mock.calls.find(
      (c) => c[0] === "account.bank.statement.line" && c[1] === "write",
    );
    expect(writeCall).toBeDefined();
    const [, , writeArgs, writeKwargs] = writeCall!;
    expect(writeArgs[0]).toEqual([ST_LINE_ID]);
    const commands = (writeArgs[1] as { line_ids: unknown[] }).line_ids;
    expect(commands[0]).toEqual([5, 0, 0]);
    const created = commands.slice(1) as Array<[number, number, Record<string, unknown>]>;
    expect(created).toHaveLength(2);
    const liquidity = created.find((c) => c[2].account_id === BANK_ACC)![2];
    const counterpart = created.find((c) => c[2].account_id === PAYABLE_ACC)![2];
    expect(liquidity).toMatchObject({ debit: 0, credit: 622.27, amount_currency: -622.27 });
    expect(counterpart).toMatchObject({ debit: 622.27, credit: 0, amount_currency: 622.27 });
    // The original line labels must survive the rewrite. Odoo syncs the
    // liquidity line's name back into the statement line's `payment_ref` via
    // `_synchronize_from_moves`, so dropping it silently destroys the raw bank
    // text — observed for real on the demo instance.
    expect(liquidity.name).toBe("BILL/2024/01/0001");
    expect(counterpart.name).toBe("BILL/2024/01/0001");
    // No line may remain on the suspense account.
    expect(created.some((c) => c[2].account_id === SUSPENSE_ACC)).toBe(false);
    // Odoo refuses the rewrite on a posted move without these context flags.
    expect(writeKwargs).toMatchObject({
      context: { force_delete: true, skip_readonly_check: true },
    });

    // Step 2: same-account reconcile of the new counterpart and the bill line.
    const reconcileCall = mockCallMethod.mock.calls.find(
      (c) => c[0] === "account.move.line" && c[1] === "reconcile",
    );
    expect(reconcileCall).toBeDefined();
    expect(reconcileCall![2]).toEqual([[102, INVOICE_LINE_ROW.id]]);

    const data = JSON.parse(result.content[0].text);
    expect(data.reconciled).toBe(true);
    expect(data.paymentState).toBe("paid");
    expect(data.amountResidual).toBe(0);
  });

  it("reports failure — and rolls back — when the bill's residual did not move", async () => {
    // The subtle trap, verified against Odoo 19: clearing the suspense line
    // (step 1) alone already flips is_reconciled to true, while the bill stays
    // unpaid. So is_reconciled proves nothing about the reconcile itself; only
    // the bill's residual does. reconcile() returns None either way, so a tool
    // trusting is_reconciled would report a success that never happened.
    stubReads({
      readBackStLine: { ...ST_LINE_ROW, is_reconciled: true },
      readBackInvoice: INVOICE_ROW, // residual unchanged at 622.27
    });
    mockCallMethod.mockResolvedValue(undefined);
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;

    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/did not reconcile|not reconciled/i);
    // The rewrite must not be left half-done: the statement line goes back to
    // its suspense counterpart rather than sitting restated-but-unmatched.
    expect(
      mockCallMethod.mock.calls.some(
        (c) =>
          c[0] === "account.bank.statement.line" &&
          c[1] === "action_undo_reconciliation",
      ),
    ).toBe(true);
  });

  it("refuses a draft invoice before writing anything", async () => {
    // Odoo 19 dropped the posted check: reconcile() on a draft line raises
    // nothing and silently does nothing. We must catch it ourselves.
    stubReads({ invoice: { ...INVOICE_ROW, state: "draft" } });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;

    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/draft|posted/i);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("refuses a statement line that is already reconciled", async () => {
    stubReads({ stLine: { ...ST_LINE_ROW, is_reconciled: true } });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;

    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/already reconciled/i);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("refuses a cross-company match", async () => {
    stubReads({ stLine: { ...ST_LINE_ROW, company_id: [5, "Clemens Helm"] } });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;

    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/compan/i);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("refuses when the invoice has no open receivable/payable line", async () => {
    stubReads({ invoiceLines: [] });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;

    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no open|nothing left to reconcile/i);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("refuses when the statement move has no suspense line to replace", async () => {
    stubReads({ stMoveLines: [ST_MOVE_LINES[0]] });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;

    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/suspense/i);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("refuses a statement move that carries an extra line beyond liquidity + suspense", async () => {
    // The rewrite clears every line ([5,0,0]) and recreates only liquidity +
    // counterpart. A third line (e.g. a split bank fee on its own account)
    // passes the exactly-one-liquidity / exactly-one-suspense guards but would
    // be silently dropped, so a move that isn't the plain two-line shape must
    // be refused rather than restated.
    const FEE_ACC = 99;
    stubReads({
      stMoveLines: [
        ...ST_MOVE_LINES,
        {
          id: 65,
          account_id: [FEE_ACC, "Bank Fees"],
          debit: 1.5,
          credit: 0,
          amount_currency: 1.5,
          partner_id: [PARTNER, "Gemini Furniture"],
          name: "Fee",
        },
      ],
    });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;

    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/line|Reconcile it in Odoo/i);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("requires write on account.move.line", async () => {
    stubReads();
    const tool = findTool(
      createApi({
        [agentId]: cfg({ ...FULL_PERMS, "account.move.line": ["read"] }),
      }),
      "odoo_reconcile",
      agentId,
    )!;
    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("requires write on account.bank.statement.line", async () => {
    stubReads();
    const tool = findTool(
      createApi({
        [agentId]: cfg({
          ...FULL_PERMS,
          "account.bank.statement.line": ["read"],
        }),
      }),
      "odoo_reconcile",
      agentId,
    )!;
    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockCallMethod).not.toHaveBeenCalled();
  });
});

describe("odoo_reconcile — invoice against an existing payment", () => {
  it("assigns the payment's counterpart line and confirms via read-back", async () => {
    stubReads({
      paymentLines: [{ id: 110, account_id: [PAYABLE_ACC, "Account Payable"] }],
    });
    mockCallMethod.mockResolvedValue(undefined);
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;

    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.payment", PAYMENT_ID),
    });

    expect(result.isError).toBeFalsy();
    const call = mockCallMethod.mock.calls.find(
      (c) => c[1] === "js_assign_outstanding_line",
    );
    expect(call).toBeDefined();
    expect(call![0]).toBe("account.move");
    // Odoo takes a scalar line id, not a list.
    expect(call![2]).toEqual([[INVOICE_ID], 110]);
    const data = JSON.parse(result.content[0].text);
    expect(data.reconciled).toBe(true);
  });

  it("refuses a canceled payment before writing anything", async () => {
    stubReads({ payment: { ...PAYMENT_ROW, state: "canceled" } });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;
    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.payment", PAYMENT_ID),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cancel|reject/i);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("refuses when the payment has no line on the invoice's account", async () => {
    stubReads({ paymentLines: [] });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;
    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("account.payment", PAYMENT_ID),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/no matching line|does not post to/i);
    expect(
      mockCallMethod.mock.calls.some((c) => c[1] === "js_assign_outstanding_line"),
    ).toBe(false);
  });
});

describe("odoo_reconcile — ref validation", () => {
  it("rejects an invoice ref for the wrong model", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;
    const result = await tool.execute("c", {
      invoice: ref("res.partner", 1),
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/account\.move/);
  });

  it("rejects a counterpart ref that is neither a bank transaction nor a payment", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;
    const result = await tool.execute("c", {
      invoice: ref("account.move", INVOICE_ID),
      counterpart: ref("res.partner", 1),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(
      /account\.bank\.statement\.line|account\.payment/,
    );
  });

  it("rejects a ref from another Odoo connection", async () => {
    const foreign = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-other",
      model: "account.move",
      id: INVOICE_ID,
      label: "x",
    });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_reconcile", agentId)!;
    const result = await tool.execute("c", {
      invoice: foreign,
      counterpart: ref("account.bank.statement.line", ST_LINE_ID),
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/connection/i);
    // The message must name the offending parameter, not a generic default —
    // decodeTargetRef is called with the `invoice` label, so a foreign
    // `invoice` ref reports `invoice`, never `target`.
    expect(result.content[0].text).toMatch(/invoice/i);
    expect(result.content[0].text).not.toMatch(/target/i);
  });
});
