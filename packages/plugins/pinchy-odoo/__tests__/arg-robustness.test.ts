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

import { asDomain, decodeUnicodeEscapes, hasItemWrappedArray } from "../index";
import plugin from "../index";

// Pattern B: the plugin lazily fetches credentials, so a stubbed endpoint is
// required before any tool executes.
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
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    id: string,
    params: Record<string, unknown>
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
      opts?: { name?: string }
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
  agentId?: string
): AgentTool | null {
  const entry = tools.find((t) => t.name === name);
  if (!entry) return null;
  return entry.factory({ agentId });
}

const agentId = "agent-1";
const CONN = "conn-test-1";

const PERMS = {
  "account.move": ["read", "create", "write"],
  "res.partner": ["read", "create", "write"],
};

function cfg(): AgentOdooConfig {
  return { connectionId: CONN, permissions: PERMS } as AgentOdooConfig;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  mockFields.mockResolvedValue([]);
});

// ---------------------------------------------------------------------------
// Unit: the pure detector for the {item: …} array-serialization artifact.
// Certain models (e.g. ollama-cloud/deepseek-v4-pro) emit array tool-args
// wrapped as single-key {item: …} objects, nested for nested arrays. Verified
// against the real production trajectory (pinchy-bugreport-penny-20260716).
// ---------------------------------------------------------------------------
describe("hasItemWrappedArray", () => {
  it("detects a single {item: …} wrapper", () => {
    expect(hasItemWrappedArray({ item: [1, 2, 3] })).toBe(true);
  });

  it("detects nested {item:{item: …}} wrapping", () => {
    expect(hasItemWrappedArray({ tax_ids: { item: { item: ["6", "0", { item: "172" }] } } })).toBe(
      true
    );
  });

  it("detects wrapping nested inside a real array", () => {
    expect(hasItemWrappedArray([{ item: [1] }])).toBe(true);
  });

  it("passes a well-formed one2many command list", () => {
    expect(hasItemWrappedArray({ invoice_line_ids: [[0, 0, { account_id: 5, name: "x" }]] })).toBe(
      false
    );
  });

  it("passes a well-formed many2many command list", () => {
    expect(hasItemWrappedArray({ tax_ids: [[6, 0, [172]]] })).toBe(false);
  });

  it("does not flag a normal record whose fields are unrelated", () => {
    expect(hasItemWrappedArray({ name: "Acme", ref: "INV/1", amount: 10 })).toBe(false);
  });

  it("does not flag a multi-key object that merely contains an 'item' key", () => {
    expect(hasItemWrappedArray({ item: 3, quantity: 1 })).toBe(false);
  });

  it("is safe on primitives and empties", () => {
    expect(hasItemWrappedArray(null)).toBe(false);
    expect(hasItemWrappedArray("item")).toBe(false);
    expect(hasItemWrappedArray([])).toBe(false);
    expect(hasItemWrappedArray({})).toBe(false);
  });
});

describe("odoo_create — {item: …} array-wrapping", () => {
  it("refuses item-wrapped values with an actionable message, before touching Odoo", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_create", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      values: {
        move_type: "in_invoice",
        invoice_line_ids: { item: { item: ["0", "0", { account_id: "7600 Office supplies" }] } },
      },
    });

    expect(result.isError).toBe(true);
    // Names the artifact and shows the correct shape so the model can retry.
    expect(result.content[0].text).toMatch(/item/i);
    expect(result.content[0].text).toMatch(/\[\[0, 0,/); // the correct o2m shape
    // Must not have forwarded the garbage to Odoo.
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockFields).not.toHaveBeenCalled();
  });

  it("still creates normally when arrays are well-formed", async () => {
    mockCreate.mockResolvedValue(42);
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_create", agentId)!;
    const result = await tool.execute("c", {
      model: "res.partner",
      values: { name: "Acme", category_id: [[6, 0, [1, 2]]] },
    });
    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalled();
  });
});

describe("odoo_read — {item: …} array-wrapping", () => {
  it("refuses an item-wrapped domain before querying Odoo", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      filters: { item: { item: ["id", "in", ["757", "758"]] } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/item/i);
    expect(mockSearchRead).not.toHaveBeenCalled();
    expect(mockFields).not.toHaveBeenCalled();
  });

  it("refuses item-wrapped fields before querying Odoo", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      fields: { item: ["id", "name"] },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/item/i);
    expect(mockSearchRead).not.toHaveBeenCalled();
  });

  it("still reads normally with a well-formed domain", async () => {
    mockSearchRead.mockResolvedValue({ records: [], length: 0 });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      filters: [["state", "=", "posted"]],
    });
    expect(result.isError).toBeFalsy();
    expect(mockSearchRead).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Unit: the domain normalizer itself. Driving it through a tool proves the
// wiring; driving it directly is how the shapes below stay cheap to state —
// the same split `hasItemWrappedArray` already has above.
// ---------------------------------------------------------------------------
describe("decodeUnicodeEscapes", () => {
  it("turns a literal \\uXXXX sequence back into its character", () => {
    expect(decodeUnicodeEscapes("\\u003c=")).toBe("<=");
    expect(decodeUnicodeEscapes("\\u0026")).toBe("&");
  });

  it("accepts uppercase hex", () => {
    expect(decodeUnicodeEscapes("\\u003C=")).toBe("<=");
  });

  it("leaves a string with no escape untouched", () => {
    expect(decodeUnicodeEscapes("ilike")).toBe("ilike");
    expect(decodeUnicodeEscapes("")).toBe("");
  });
});

describe("asDomain", () => {
  it("treats an omitted filter as match-everything", () => {
    expect(asDomain(undefined)).toEqual([]);
    expect(asDomain(null)).toEqual([]);
  });

  it("refuses a non-array, naming the parameter", () => {
    expect(() => asDomain("account_id = 5")).toThrow(/`filters` must be an array/);
  });

  // Odoo lower-cases the operator and still accepts the legacy `<>` for `!=`,
  // so refusing either spelling here would reject a domain Odoo runs happily.
  // Sending the canonical form is never worse than sending the alias.
  it("accepts the spellings Odoo normalizes away", () => {
    expect(asDomain([["name", "ILIKE", "acme"]])).toEqual([["name", "ilike", "acme"]]);
    expect(asDomain([["partner_id", "In", [1, 2]]])).toEqual([["partner_id", "in", [1, 2]]]);
    expect(asDomain([["state", "<>", "draft"]])).toEqual([["state", "!=", "draft"]]);
  });

  // `&` is the character a model escapes most reflexively of all, so the
  // operator position of a CONDITION is not the only place #1198 lands.
  it("decodes an escaped logical operator", () => {
    expect(
      asDomain(["\\u0026", ["state", "=", "posted"], ["date", "\\u003e=", "2026-06-01"]])
    ).toEqual(["&", ["state", "=", "posted"], ["date", ">=", "2026-06-01"]]);
  });

  it("refuses a bare string that is not a logical operator", () => {
    expect(() => asDomain(["AND", ["state", "=", "posted"]])).toThrow(
      /Unsupported domain term "AND"/
    );
  });

  // `any` / `not any` carry a domain as their value, and the escape lands one
  // level in as readily as at the top.
  it("normalizes the sub-domain of any / not any", () => {
    expect(asDomain([["invoice_line_ids", "any", [["date", "\\u003c=", "2026-06-30"]]]])).toEqual([
      ["invoice_line_ids", "any", [["date", "<=", "2026-06-30"]]],
    ]);
  });

  it("leaves a non-array `any` value alone rather than inventing a refusal", () => {
    expect(asDomain([["invoice_line_ids", "any", 5]])).toEqual([["invoice_line_ids", "any", 5]]);
  });

  // A domain one level too deep is a shape models produce as readily as the
  // {item: …} artifact. Reading the middle element of such an entry yields the
  // honest-but-useless "the operator must be a string"; name the nesting.
  it.each([
    [[["&", ["state", "=", "posted"], ["date", ">=", "2026-06-01"]]]],
    [
      [
        [
          ["state", "=", "posted"],
          ["date", ">=", "2026-06-01"],
        ],
      ],
    ],
    [[[["state", "=", "posted"]]]],
  ])("refuses a domain nested one level too deep (%#)", (nested) => {
    expect(() => asDomain(nested)).toThrow(/nested one level too deep/);
  });

  it("refuses a non-string operator without echoing the value", () => {
    expect(() => asDomain([["date", 5, "2026-06-30"]])).toThrow(
      /Invalid condition on field "date": the operator must be a string/
    );
  });

  // The refusal names the field and the operator and NOT the value. The value
  // is the caller's own search text; echoing it back into an error message is
  // how caller-supplied prose ends up being read as a diagnosis downstream —
  // `isAuthError` matches on words, and "unauthorized" is an ordinary thing to
  // search an accounting database for.
  it("does not echo the value into the refusal", () => {
    expect(() => asDomain([["name", "contains", "Unauthorized charge dispute"]])).toThrow(
      /Unsupported operator "contains" on field "name"/
    );
    expect(() => asDomain([["name", "contains", "Unauthorized charge dispute"]])).not.toThrow(
      /Unauthorized/
    );
  });
});

// heypinchy/pinchy#1198. Some models emit `<` and `>` in their JSON-escaped
// form, and when the escape is not decoded on the way in the six-character
// literal `<=` arrives as the operator. Odoo then rejects the whole
// domain: `Invalid operator in condition ('date', '<=', '2026-06-30')`.
// Observed twice on production in one booking session — the date-bounded query
// the agent needed simply never ran.
//
// The escaping happens inside the provider's own tool-argument serialization,
// not in anything the agent controls, so a prompt cannot suppress it — and the
// error tells the model nothing it can act on, because the operator looks
// correct in its own output.
describe("odoo_read — unicode-escaped domain operators", () => {
  const ESCAPED: Array<[string, string]> = [
    ["\\u003c", "<"],
    ["\\u003c=", "<="],
    ["\\u003e", ">"],
    ["\\u003e=", ">="],
    ["\\u0021=", "!="],
  ];

  it.each(ESCAPED)("decodes %s to %s before querying Odoo", async (escaped, decoded) => {
    mockSearchRead.mockResolvedValue({ records: [], length: 0 });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;

    const result = await tool.execute("c", {
      model: "account.move",
      filters: [["date", escaped, "2026-06-30"]],
    });

    expect(result.isError).toBeFalsy();
    expect(mockSearchRead).toHaveBeenCalledWith(
      "account.move",
      [["date", decoded, "2026-06-30"]],
      expect.anything()
    );
  });

  it("decodes uppercase-hex escapes too", async () => {
    mockSearchRead.mockResolvedValue({ records: [], length: 0 });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;

    await tool.execute("c", {
      model: "account.move",
      filters: [["date", "\\u003C=", "2026-06-30"]],
    });

    expect(mockSearchRead).toHaveBeenCalledWith(
      "account.move",
      [["date", "<=", "2026-06-30"]],
      expect.anything()
    );
  });

  // Decoding without validating just moves the dead end one step: the next
  // escape variant would still reach Odoo. An operator that is not one Odoo
  // accepts is refused HERE, with the list, so the model can correct itself
  // instead of reading a server error about a string it believes it never sent.
  //
  // "Before querying" has to mean before the FIRST call, not before
  // search_read: odoo_read reads `fields_get` on the way in, so asserting only
  // that search_read was skipped would leave a real Odoo round trip — and a
  // credentials fetch — unaccounted for.
  it("refuses an operator Odoo does not accept, before any Odoo call", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;

    const result = await tool.execute("c", {
      model: "account.move",
      filters: [["date", "=<", "2026-06-30"]],
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/=</);
    expect(result.content[0].text).toMatch(/<=/); // names a valid one
    expect(mockSearchRead).not.toHaveBeenCalled();
    expect(mockFields).not.toHaveBeenCalled();
  });

  it("refuses before querying in odoo_count too", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_count", agentId)!;

    const result = await tool.execute("c", {
      model: "account.move",
      filters: [["date", "=<", "2026-06-30"]],
    });

    expect(result.isError).toBe(true);
    expect(mockSearchCount).not.toHaveBeenCalled();
  });

  it("refuses before querying in odoo_aggregate too", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_aggregate", agentId)!;

    const result = await tool.execute("c", {
      model: "account.move",
      filters: [["date", "=<", "2026-06-30"]],
      fields: ["amount_total:sum"],
      groupby: ["partner_id"],
    });

    expect(result.isError).toBe(true);
    expect(mockReadGroup).not.toHaveBeenCalled();
  });

  it("decodes the domain for odoo_count and odoo_aggregate as well", async () => {
    mockSearchCount.mockResolvedValue(3);
    mockReadGroup.mockResolvedValue([]);
    const tools = createApi({ [agentId]: cfg() });

    await findTool(tools, "odoo_count", agentId)!.execute("c", {
      model: "account.move",
      filters: [["date", "\\u003c=", "2026-06-30"]],
    });
    expect(mockSearchCount).toHaveBeenCalledWith("account.move", [["date", "<=", "2026-06-30"]]);

    await findTool(tools, "odoo_aggregate", agentId)!.execute("c", {
      model: "account.move",
      filters: [["date", "\\u003c=", "2026-06-30"]],
      fields: ["amount_total:sum"],
      groupby: ["partner_id"],
    });
    expect(mockReadGroup).toHaveBeenCalledWith(
      "account.move",
      [["date", "<=", "2026-06-30"]],
      ["amount_total:sum"],
      ["partner_id"],
      expect.anything()
    );
  });

  it("leaves logical operators and well-formed conditions untouched", async () => {
    mockSearchRead.mockResolvedValue({ records: [], length: 0 });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;

    const domain = [
      "&",
      ["state", "=", "posted"],
      "|",
      ["date", ">=", "2026-06-01"],
      ["partner_id", "ilike", "acme"],
    ];
    await tool.execute("c", { model: "account.move", filters: domain });

    expect(mockSearchRead).toHaveBeenCalledWith("account.move", domain, expect.anything());
  });

  // A value that happens to contain a backslash-u sequence is legitimate; only
  // the OPERATOR position is normalized. Rewriting values would corrupt a
  // genuine search string, and no operator can ever legitimately be one.
  //
  // The value half of #1198 is NOT closed by that asymmetry — an escaped value
  // matches nothing and the agent reads the empty result as "there is nothing
  // there", which is worse than the loud failure this file fixes. Tracked in
  // #1213; this test pins today's behaviour, not the desired end state.
  it("does not rewrite escape sequences in the value position", async () => {
    mockSearchRead.mockResolvedValue({ records: [], length: 0 });
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;

    await tool.execute("c", {
      model: "account.move",
      filters: [["ref", "=", "\\u003cliteral\\u003e"]],
    });

    expect(mockSearchRead).toHaveBeenCalledWith(
      "account.move",
      [["ref", "=", "\\u003cliteral\\u003e"]],
      expect.anything()
    );
  });
});

describe("odoo_write — {item: …} array-wrapping", () => {
  it("refuses item-wrapped values with an actionable message, before touching Odoo", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_write", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      ids: [42],
      values: {
        invoice_line_ids: { item: { item: ["1", "10", { price_unit: "8.33" }] } },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/item/i);
    expect(result.content[0].text).toMatch(/\[\[0, 0,/); // the correct o2m shape
    expect(mockWrite).not.toHaveBeenCalled();
    expect(mockFields).not.toHaveBeenCalled();
  });

  it("still writes normally when arrays are well-formed", async () => {
    mockWrite.mockResolvedValue(true);
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_write", agentId)!;
    const result = await tool.execute("c", {
      model: "res.partner",
      ids: [1],
      values: { category_id: [[6, 0, [1, 2]]] },
    });
    expect(result.isError).toBeFalsy();
    expect(mockWrite).toHaveBeenCalled();
  });
});

describe("odoo_count — {item: …} array-wrapping", () => {
  it("refuses an item-wrapped domain before querying Odoo", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_count", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      filters: { item: { item: ["state", "=", "posted"] } },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/item/i);
    expect(mockSearchCount).not.toHaveBeenCalled();
  });
});

describe("odoo_aggregate — {item: …} array-wrapping", () => {
  it("refuses an item-wrapped domain before querying Odoo", async () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_aggregate", agentId)!;
    const result = await tool.execute("c", {
      model: "account.move",
      filters: { item: { item: ["state", "=", "posted"] } },
      fields: ["amount_total:sum"],
      groupby: ["partner_id"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/item/i);
    expect(mockReadGroup).not.toHaveBeenCalled();
  });
});

describe("relation-field name string — Postgres integer error is translated", () => {
  it("turns a raw 'invalid input syntax for type integer' into actionable guidance", async () => {
    mockCreate.mockRejectedValue(
      new Error('invalid input syntax for type integer: "7600 Office supplies and printed forms"')
    );
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_create", agentId)!;
    const result = await tool.execute("c", {
      model: "res.partner",
      values: { name: "Acme" },
    });
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    // Keeps the original signal but adds what to do about it.
    expect(text).toMatch(/invalid input syntax for type integer/i);
    expect(text).toMatch(/relation|odoo_read|numeric id|_pinchy_ref/i);
  });
});

describe("tool descriptions carry a correct-shape example", () => {
  it("odoo_create description shows the plain-array command shape and warns against {item}", () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_create", agentId)!;
    expect(tool.description).toMatch(/\[\[0, 0,/);
    expect(tool.description).toMatch(/item/i);
  });

  it("odoo_write description shows the plain-array command shape and warns against {item}", () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_write", agentId)!;
    expect(tool.description).toMatch(/\[\[0, 0,/);
    expect(tool.description).toMatch(/item/i);
  });

  it("odoo_read filters description warns against {item} wrapping", () => {
    const tool = findTool(createApi({ [agentId]: cfg() }), "odoo_read", agentId)!;
    const props = (tool.parameters as { properties: Record<string, { description?: string }> })
      .properties;
    expect(props.filters.description).toMatch(/item/i);
  });
});
