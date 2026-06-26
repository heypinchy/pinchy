// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { OdooField } from "../index";

// Mock odoo-node before importing the plugin
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

// Mock the io wrapper for odoo_attach_file tests
const { mockReadFile, mockStat } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockStat: vi.fn(),
}));
vi.mock("../io", () => ({ readFile: mockReadFile, stat: mockStat }));

import { OdooClient } from "odoo-node";
import { encodeRef, decodeRef } from "../integration-ref";
import plugin, {
  compactType,
  normalizeFields,
  sortFieldsByPriority,
  compactSchema,
  augmentFieldsWithCompanyId,
  extractCompanyLabel,
  extractCompanyId,
  formatMultiMatchError,
  assertNoCrossCompanyRefs,
  PRODUCT_REF_DISAMBIGUATION_HINT,
} from "../index";

interface AgentTool {
  name: string;
  label: string;
  description: string;
  parameters: Record<string, unknown>;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
}

// The plugin no longer takes credentials in its config — it fetches them
// on demand from Pinchy's internal credentials API. Tests stub `fetch`
// to return a canonical credentials response for any connectionId.
const testCredentials = {
  url: "https://odoo.example.com",
  db: "testdb",
  uid: 2,
  apiKey: "test-api-key",
};

const testPermissions = {
  "sale.order": ["read"],
  "res.partner": ["read", "write", "create"],
};

const fetchMock = vi.fn(async () => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({ type: "odoo", credentials: testCredentials }),
}));
// Vitest typing dance: cast through unknown for mock fetch
globalThis.fetch = fetchMock as unknown as typeof fetch;

function createApi(agentConfigs: Record<string, unknown> = {}) {
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

  plugin.register(api);
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
const agentConfig = {
  connectionId: "conn-test-1",
  permissions: testPermissions,
  modelNames: {
    "sale.order": "Sales Order",
    "res.partner": "Contact",
    "account.move": "Journal Entry",
  },
};

describe("compactType", () => {
  it("maps primitive types to short tokens", () => {
    expect(compactType({ name: "id", type: "integer" })).toBe("int");
    expect(compactType({ name: "name", type: "char" })).toBe("char");
    expect(compactType({ name: "amount", type: "float" })).toBe("float");
    expect(compactType({ name: "active", type: "boolean" })).toBe("bool");
    expect(compactType({ name: "notes", type: "text" })).toBe("text");
    expect(compactType({ name: "date", type: "date" })).toBe("date");
    expect(compactType({ name: "ts", type: "datetime" })).toBe("datetime");
  });

  it("falls back to the raw type string for known-but-unshortened types", () => {
    expect(compactType({ name: "weird", type: "binary" })).toBe("binary");
  });

  it("returns 'unknown' for undefined type", () => {
    expect(
      compactType({ name: "wtf", type: undefined as unknown as string }),
    ).toBe("unknown");
  });

  it("encodes many2one as 'm2o:<relation>'", () => {
    expect(
      compactType({
        name: "partner_id",
        type: "many2one",
        relation: "res.partner",
      }),
    ).toBe("m2o:res.partner");
  });

  it("encodes one2many as 'o2m:<relation>'", () => {
    expect(
      compactType({
        name: "line_ids",
        type: "one2many",
        relation: "account.move.line",
      }),
    ).toBe("o2m:account.move.line");
  });

  it("encodes many2many as 'm2m:<relation>'", () => {
    expect(
      compactType({
        name: "tag_ids",
        type: "many2many",
        relation: "res.partner.category",
      }),
    ).toBe("m2m:res.partner.category");
  });

  it("falls back to '<type>:?' if relation is missing", () => {
    expect(compactType({ name: "x", type: "many2one" })).toBe("m2o:?");
  });

  it("encodes selection as 'selection:<a>|<b>|<c>'", () => {
    expect(
      compactType({
        name: "state",
        type: "selection",
        selection: [
          ["draft", "Draft"],
          ["posted", "Posted"],
          ["cancel", "Cancelled"],
        ],
      }),
    ).toBe("selection:draft|posted|cancel");
  });

  it("handles selection with one option", () => {
    expect(
      compactType({
        name: "color",
        type: "selection",
        selection: [["red", "Red"]],
      }),
    ).toBe("selection:red");
  });

  it("handles selection without options (empty array)", () => {
    expect(compactType({ name: "x", type: "selection", selection: [] })).toBe(
      "selection:",
    );
  });

  it("handles selection without options (undefined)", () => {
    expect(compactType({ name: "x", type: "selection" })).toBe("selection:");
  });

  it("truncates selection options past 20 with '|...'", () => {
    const opts: Array<[string, string]> = Array.from({ length: 25 }, (_, i) => [
      `opt${i}`,
      `Option ${i}`,
    ]);
    const result = compactType({
      name: "x",
      type: "selection",
      selection: opts,
    });
    expect(result).toMatch(/^selection:opt0\|opt1\|.*\|opt19\|\.\.\.$/);
    expect(result.split("|")).toHaveLength(21); // 20 opts + "..."
  });

  it("does not truncate selections of exactly 20", () => {
    const opts: Array<[string, string]> = Array.from({ length: 20 }, (_, i) => [
      `opt${i}`,
      `Option ${i}`,
    ]);
    const result = compactType({
      name: "x",
      type: "selection",
      selection: opts,
    });
    expect(result.endsWith("|...")).toBe(false);
    expect(result.split("|")).toHaveLength(20);
  });
});

describe("normalizeFields", () => {
  it("preserves selection options through normalization", () => {
    const raw = {
      state: {
        name: "state",
        type: "selection",
        string: "Status",
        selection: [
          ["draft", "Draft"],
          ["posted", "Posted"],
        ],
      },
    };
    const result = normalizeFields(raw);
    const stateField = result.find((f) => f.name === "state");
    expect(stateField).toBeDefined();
    expect(stateField!.selection).toEqual([
      ["draft", "Draft"],
      ["posted", "Posted"],
    ]);
  });

  it("preserves readonly and required flags", () => {
    const raw = {
      partner_id: {
        name: "partner_id",
        type: "many2one",
        string: "Partner",
        relation: "res.partner",
        readonly: true,
        required: false,
      },
      name_field: {
        name: "name_field",
        type: "char",
        string: "Name",
        readonly: false,
        required: true,
      },
    };
    const result = normalizeFields(raw);
    const partner = result.find((f) => f.name === "partner_id");
    const nameF = result.find((f) => f.name === "name_field");
    expect(partner?.readonly).toBe(true);
    expect(partner?.required).toBe(false);
    expect(nameF?.readonly).toBe(false);
    expect(nameF?.required).toBe(true);
  });
});

describe("sortFieldsByPriority", () => {
  it("places COMMON_FIELDS first in canonical order, then alphabetical", () => {
    const input: OdooField[] = [
      { name: "x_custom_field", type: "char" },
      { name: "amount_total", type: "float" },
      { name: "id", type: "integer" },
      { name: "partner_id", type: "many2one", relation: "res.partner" },
      { name: "active", type: "boolean" },
      { name: "z_alpha_last", type: "char" },
      { name: "name", type: "char" },
    ];
    const sorted = sortFieldsByPriority(input);
    expect(sorted.map((f) => f.name)).toEqual([
      "id",
      "name",
      "active",
      "partner_id",
      "amount_total",
      "x_custom_field",
      "z_alpha_last",
    ]);
  });

  it("is a pure function — does not mutate input", () => {
    const input: OdooField[] = [
      { name: "b", type: "char" },
      { name: "a", type: "char" },
    ];
    sortFieldsByPriority(input);
    expect(input.map((f) => f.name)).toEqual(["b", "a"]);
  });
});

describe("compactSchema", () => {
  const baseFields: OdooField[] = [
    { name: "id", type: "integer" },
    { name: "name", type: "char" },
    { name: "partner_id", type: "many2one", relation: "res.partner" },
  ];

  it("returns compact field map keyed by name with short type codes", () => {
    const out = compactSchema(baseFields, { limit: 40, verbose: false });
    expect(out.fields).toEqual({
      id: "int",
      name: "char",
      partner_id: "m2o:res.partner",
    });
  });

  it("includes _meta with total/returned/truncated", () => {
    const out = compactSchema(baseFields, { limit: 40, verbose: false });
    expect(out._meta).toEqual({
      total: 3,
      returned: 3,
      truncated: false,
    });
  });

  it("with fields:[a,b] returns only those (ignoring limit)", () => {
    const fs: OdooField[] = [
      { name: "a", type: "char" },
      { name: "b", type: "char" },
      { name: "c", type: "char" },
    ];
    const out = compactSchema(fs, {
      fields: ["a", "b"],
      limit: 1,
      verbose: false,
    });
    expect(Object.keys(out.fields)).toEqual(["a", "b"]);
    expect(out._meta.returned).toBe(2);
    expect(out._meta.truncated).toBe(false);
  });

  it("with fields:[unknown] returns empty fields + hint", () => {
    const fs: OdooField[] = [{ name: "a", type: "char" }];
    const out = compactSchema(fs, {
      fields: ["does_not_exist"],
      limit: 40,
      verbose: false,
    });
    expect(out.fields).toEqual({});
    expect(out._meta.returned).toBe(0);
    expect(out._meta.hint).toMatch(/no requested fields/i);
  });

  it("with fields:['__all__'] returns every field, no limit", () => {
    const fs: OdooField[] = Array.from({ length: 50 }, (_, i) => ({
      name: `f${i}`,
      type: "char" as const,
    }));
    const out = compactSchema(fs, {
      fields: ["__all__"],
      limit: 40,
      verbose: false,
    });
    expect(out._meta.returned).toBe(50);
    expect(out._meta.truncated).toBe(false);
  });

  it("emits truncation hint when truncated", () => {
    const fs: OdooField[] = Array.from({ length: 50 }, (_, i) => ({
      name: `f${i}`,
      type: "char" as const,
    }));
    const out = compactSchema(fs, { limit: 10, verbose: false });
    expect(out._meta.truncated).toBe(true);
    expect(out._meta.returned).toBe(10);
    expect(out._meta.hint).toMatch(/__all__/);
  });

  it("verbose:true returns full Odoo metadata (readonly/required/string)", () => {
    const fs: OdooField[] = [
      {
        name: "name",
        type: "char",
        readonly: false,
        required: true,
        string: "Name",
      },
    ];
    const out = compactSchema(fs, { limit: 40, verbose: true });
    expect(out.fields).toEqual({
      name: {
        type: "char",
        required: true,
        readonly: false,
        string: "Name",
      },
    });
  });

  it("verbose:true does not omit falsy flags", () => {
    const fs: OdooField[] = [
      {
        name: "id",
        type: "integer",
        readonly: true,
        required: false,
        string: "ID",
      },
    ];
    const out = compactSchema(fs, { limit: 40, verbose: true });
    expect((out.fields.id as { readonly: boolean }).readonly).toBe(true);
  });

  it("treats fields:[] like an omitted filter (default-truncates with hint)", () => {
    const fs: OdooField[] = Array.from({ length: 50 }, (_, i) => ({
      name: `f${i}`,
      type: "char" as const,
    }));
    const out = compactSchema(fs, { fields: [], limit: 10, verbose: false });
    expect(out._meta.returned).toBe(10);
    expect(out._meta.truncated).toBe(true);
    expect(out._meta.hint).toMatch(/__all__/);
  });

  it("clamps a negative limit to 0", () => {
    const fs: OdooField[] = [
      { name: "a", type: "char" },
      { name: "b", type: "char" },
    ];
    const out = compactSchema(fs, { limit: -1, verbose: false });
    expect(out._meta.returned).toBe(0);
    expect(out._meta.truncated).toBe(true);
  });

  it("clamps a non-finite limit to a sane default (40)", () => {
    const fs: OdooField[] = Array.from({ length: 50 }, (_, i) => ({
      name: `f${i}`,
      type: "char" as const,
    }));
    const out = compactSchema(fs, { limit: Number.NaN, verbose: false });
    expect(out._meta.returned).toBe(40);
    expect(out._meta.truncated).toBe(true);
  });

  // Issue #377: agents confuse Odoo's internal numeric `id` with `default_code`
  // (the human-readable SKU / internal reference). When a model has both
  // fields, surface a disambiguation hint in the describe output so the LLM
  // can see the distinction at the point of decision.
  describe("id vs default_code disambiguation (issue #377)", () => {
    it("annotates id and default_code in compact mode when both are present", () => {
      const fs: OdooField[] = [
        { name: "id", type: "integer" },
        { name: "default_code", type: "char" },
        { name: "name", type: "char" },
      ];
      const out = compactSchema(fs, { limit: 40, verbose: false });
      expect(String(out.fields.id)).toMatch(/NOT the SKU/i);
      expect(String(out.fields.default_code)).toMatch(/NOT the database id/i);
      expect(String(out.fields.default_code)).toMatch(
        /SKU|internal reference/i,
      );
      // Unrelated fields stay as plain compact type strings.
      expect(out.fields.name).toBe("char");
    });

    it("does not annotate id when default_code is absent", () => {
      const fs: OdooField[] = [
        { name: "id", type: "integer" },
        { name: "name", type: "char" },
      ];
      const out = compactSchema(fs, { limit: 40, verbose: false });
      expect(out.fields.id).toBe("int");
    });

    // Behavior widened post-review: annotate based on what the *model
    // declares*, not just what the current response window happens to show.
    // Filtering down to one of the two fields is exactly when the agent is
    // most likely to confuse them — that's when the warning matters most.
    it("annotates default_code when filtered alone but id is declared in the model", () => {
      const fs: OdooField[] = [
        { name: "id", type: "integer" },
        { name: "default_code", type: "char" },
      ];
      const out = compactSchema(fs, {
        fields: ["default_code"],
        limit: 40,
        verbose: false,
      });
      expect(String(out.fields.default_code)).toMatch(/NOT the database id/i);
      expect(String(out.fields.default_code)).toMatch(
        /SKU|internal reference/i,
      );
    });

    // Symmetric case to the one above.
    it("annotates id when filtered alone but default_code is declared in the model", () => {
      const fs: OdooField[] = [
        { name: "id", type: "integer" },
        { name: "default_code", type: "char" },
      ];
      const out = compactSchema(fs, {
        fields: ["id"],
        limit: 40,
        verbose: false,
      });
      expect(String(out.fields.id)).toMatch(/NOT the SKU/i);
    });

    // Noise control: non-product models that happen to expose `id` (every
    // model does) but lack `default_code` must stay quiet.
    it("does not annotate id on a model that does not declare default_code", () => {
      const fs: OdooField[] = [
        { name: "id", type: "integer" },
        { name: "amount_total", type: "float" },
        { name: "state", type: "char" },
      ];
      const out = compactSchema(fs, { limit: 40, verbose: false });
      expect(out.fields.id).toBe("int");
    });

    it("annotates id and default_code in verbose mode too", () => {
      const fs: OdooField[] = [
        { name: "id", type: "integer" },
        { name: "default_code", type: "char" },
      ];
      const out = compactSchema(fs, { limit: 40, verbose: true });
      const idField = out.fields.id as { note?: string };
      const dcField = out.fields.default_code as { note?: string };
      expect(idField.note).toMatch(/NOT the SKU/i);
      expect(dcField.note).toMatch(/NOT the database id/i);
    });
  });
});

describe("augmentFieldsWithCompanyId", () => {
  it("returns undefined when requested is undefined", () => {
    const modelFields: OdooField[] = [
      { name: "company_id", type: "many2one", relation: "res.company" },
    ];
    expect(augmentFieldsWithCompanyId(undefined, modelFields)).toBeUndefined();
  });

  it("returns the original list (referentially equal) when the model has no company_id field", () => {
    const requested = ["name", "code"];
    const modelFields: OdooField[] = [
      { name: "id", type: "integer" },
      { name: "name", type: "char" },
      { name: "code", type: "char" },
    ];
    const result = augmentFieldsWithCompanyId(requested, modelFields);
    expect(result).toBe(requested);
  });

  it("returns the original list (referentially equal) when company_id is named but is not a many2one (the discriminator's other half)", () => {
    const requested = ["name"];
    const modelFields: OdooField[] = [
      { name: "name", type: "char" },
      // Some hypothetical model that exposes `company_id` as a non-relational
      // field — the helper must only auto-include the real m2o multi-company
      // foreign key, not a column that happens to share the name.
      { name: "company_id", type: "integer" },
    ];
    const result = augmentFieldsWithCompanyId(requested, modelFields);
    expect(result).toBe(requested);
  });

  it("returns the original list (referentially equal) when company_id is already in the requested list", () => {
    const requested = ["company_id", "name"];
    const modelFields: OdooField[] = [
      { name: "name", type: "char" },
      { name: "company_id", type: "many2one", relation: "res.company" },
    ];
    const result = augmentFieldsWithCompanyId(requested, modelFields);
    expect(result).toBe(requested);
  });

  it("returns a NEW array appending company_id when the model has it and the LLM did not ask for it", () => {
    const requested = ["code", "name"];
    const modelFields: OdooField[] = [
      { name: "code", type: "char" },
      { name: "name", type: "char" },
      { name: "company_id", type: "many2one", relation: "res.company" },
    ];
    const result = augmentFieldsWithCompanyId(requested, modelFields);
    expect(result).not.toBe(requested);
    expect(result).toEqual(["code", "name", "company_id"]);
  });

  it("treats requested === [] as 'didn't ask' — returns [] unchanged (referentially equal)", () => {
    // Parity with compactSchema, which normalizes `fields: []` ≡ `undefined`.
    // An empty fields list is the LLM saying "I didn't pick anything" — the
    // helper must not silently turn that into `["company_id"]`, which would
    // make Odoo return only company_id and silently change behaviour vs.
    // pre-Task-1.
    const requested: string[] = [];
    const modelFields: OdooField[] = [
      { name: "company_id", type: "many2one", relation: "res.company" },
    ];
    const result = augmentFieldsWithCompanyId(requested, modelFields);
    expect(result).toBe(requested);
  });
});

describe("extractCompanyLabel", () => {
  it("returns the string label from a [id, name] tuple", () => {
    expect(extractCompanyLabel([1, "GmbH A"])).toBe("GmbH A");
  });
  it("returns null when value is false (single-company tenant)", () => {
    expect(extractCompanyLabel(false)).toBeNull();
  });
  it("returns null when value is undefined or missing", () => {
    expect(extractCompanyLabel(undefined)).toBeNull();
    expect(extractCompanyLabel(null)).toBeNull();
  });
  it("returns null when the second tuple element is not a non-empty string", () => {
    expect(extractCompanyLabel([1, ""])).toBeNull();
    expect(extractCompanyLabel([1, 42])).toBeNull();
    expect(extractCompanyLabel([1])).toBeNull();
  });
  it("returns null when value is not an array", () => {
    expect(extractCompanyLabel("GmbH A")).toBeNull();
    expect(extractCompanyLabel(42)).toBeNull();
    expect(extractCompanyLabel({})).toBeNull();
  });
});

describe("extractCompanyId", () => {
  it("returns the numeric id from a [id, name] tuple", () => {
    expect(extractCompanyId([7, "GmbH A"])).toBe(7);
  });
  it("returns null when value is false (single-company tenant)", () => {
    expect(extractCompanyId(false)).toBeNull();
  });
  it("returns null when value is undefined / null", () => {
    expect(extractCompanyId(undefined)).toBeNull();
    expect(extractCompanyId(null)).toBeNull();
  });
  it("returns null when the first element is not a positive integer", () => {
    expect(extractCompanyId([0, "x"])).toBeNull();
    expect(extractCompanyId([-1, "x"])).toBeNull();
    expect(extractCompanyId([1.5, "x"])).toBeNull();
    expect(extractCompanyId(["7", "x"])).toBeNull();
  });
  it("returns null when value is not an array", () => {
    expect(extractCompanyId("GmbH A")).toBeNull();
    expect(extractCompanyId(7)).toBeNull();
    expect(extractCompanyId({})).toBeNull();
  });
  it("returns null when the label slot is missing or empty (mutual presence)", () => {
    // Symmetry with `extractCompanyLabel`: a partial tuple is treated as
    // unusable. Without this guard, an exported helper would let a future
    // out-of-tree caller spread `{ companyId: 7, companyLabel: undefined }`
    // into encodeRef and trip the validator at runtime. Refusing the partial
    // shape here keeps the foot-gun out of the public surface.
    expect(extractCompanyId([7])).toBeNull();
    expect(extractCompanyId([7, undefined])).toBeNull();
    expect(extractCompanyId([7, ""])).toBeNull();
    expect(extractCompanyId([7, 42])).toBeNull(); // wrong type
  });
});

describe("assertNoCrossCompanyRefs", () => {
  beforeEach(() => {
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  function tagged(
    model: string,
    id: number,
    companyId: number,
    companyLabel: string,
  ) {
    return {
      ref: encodeRef({
        integrationType: "odoo",
        connectionId: "u",
        model,
        id,
        label: "x",
        companyId,
        companyLabel,
      }),
    };
  }
  function untagged(model: string, id: number) {
    return {
      ref: encodeRef({
        integrationType: "odoo",
        connectionId: "u",
        model,
        id,
        label: "x",
      }),
    };
  }

  it("is a no-op when values has no company_id key", () => {
    expect(() =>
      assertNoCrossCompanyRefs({
        account_id: tagged("account.account", 1, 1, "A"),
      }),
    ).not.toThrow();
  });

  it("is a no-op when values.company_id ref is untagged (legacy)", () => {
    expect(() =>
      assertNoCrossCompanyRefs({
        company_id: untagged("res.company", 1),
        account_id: tagged("account.account", 1, 2, "B"),
      }),
    ).not.toThrow();
  });

  it("is a no-op when all other refs are untagged", () => {
    expect(() =>
      assertNoCrossCompanyRefs({
        company_id: tagged("res.company", 1, 1, "A"),
        partner_id: untagged("res.partner", 99),
      }),
    ).not.toThrow();
  });

  it("throws when a tagged sibling disagrees on companyId", () => {
    expect(() =>
      assertNoCrossCompanyRefs({
        company_id: tagged("res.company", 1, 1, "GmbH A"),
        account_id: tagged("account.account", 42, 2, "GmbH B"),
      }),
    ).toThrow(/cross-company/i);
  });

  it("includes both company labels in the error message", () => {
    try {
      assertNoCrossCompanyRefs({
        company_id: tagged("res.company", 1, 1, "GmbH A"),
        account_id: tagged("account.account", 42, 2, "GmbH B"),
      });
      throw new Error("did not throw");
    } catch (err) {
      expect(String(err)).toMatch(/GmbH A/);
      expect(String(err)).toMatch(/GmbH B/);
      expect(String(err)).toMatch(/account_id/);
    }
  });

  it("does not throw when values is empty", () => {
    expect(() => assertNoCrossCompanyRefs({})).not.toThrow();
  });

  it("ignores non-ref values (raw strings, numbers, etc.) for both target and siblings", () => {
    expect(() =>
      assertNoCrossCompanyRefs({
        company_id: tagged("res.company", 1, 1, "A"),
        account_id: "1000 Wareneinsatz", // string lookup, not a ref
        partner_id: 42, // raw id (would be rejected later, but not by this guard)
      }),
    ).not.toThrow();
  });
});

describe("formatMultiMatchError", () => {
  const field = {
    name: "account_id",
    string: "Account",
    type: "many2one",
    required: true,
    readonly: false,
    relation: "account.account",
  } as OdooField;

  it("emits a multi-company collision message when matches span 2+ companies", () => {
    const msg = formatMultiMatchError(field, { name: "1000 Wareneinsatz" }, [
      {
        id: 42,
        name: "Wareneinsatz",
        display_name: "1000 Wareneinsatz",
        company_id: [1, "GmbH A"],
      },
      {
        id: 87,
        name: "Wareneinsatz",
        display_name: "1000 Wareneinsatz",
        company_id: [2, "GmbH B"],
      },
    ]);
    expect(msg).toMatch(/multi-company collision/);
    expect(msg).toContain('"GmbH A"');
    expect(msg).toContain('"GmbH B"');
    expect(msg).toMatch(/company_id/);
    expect(msg).toMatch(/_pinchy_ref/);
  });

  it("falls back to the plain message when all matches are in the same company", () => {
    const msg = formatMultiMatchError(field, { name: "Foo" }, [
      { id: 1, name: "Foo", display_name: "Foo", company_id: [1, "GmbH A"] },
      { id: 2, name: "Foo", display_name: "Foo", company_id: [1, "GmbH A"] },
    ]);
    expect(msg).toMatch(/multiple Account records match "Foo"/);
    expect(msg).not.toMatch(/multi-company collision/);
  });

  it("falls back to the plain message when no records carry company_id at all", () => {
    const msg = formatMultiMatchError(field, { name: "Bar" }, [
      { id: 1, name: "Bar", display_name: "Bar" },
      { id: 2, name: "Bar", display_name: "Bar" },
    ]);
    expect(msg).not.toMatch(/multi-company collision/);
  });

  it("uses code over name when present in the lookup", () => {
    const msg = formatMultiMatchError(field, { code: "AT", name: "Austria" }, [
      { id: 1, name: "x", display_name: "x", company_id: [1, "GmbH A"] },
      { id: 2, name: "x", display_name: "x", company_id: [2, "GmbH B"] },
    ]);
    expect(msg).toContain('"AT"');
  });

  it("uses field.string for the human label, falling back to field.name", () => {
    const noStringField = { ...field, string: undefined } as OdooField;
    const msg = formatMultiMatchError(noStringField, { name: "x" }, [
      { id: 1, name: "x", display_name: "x", company_id: [1, "GmbH A"] },
    ]);
    expect(msg).toMatch(/multiple account_id records/);
  });

  it("caps the displayed company list at 5 and indicates overflow", () => {
    const records = Array.from({ length: 8 }, (_, i) => ({
      id: i + 1,
      name: "X",
      display_name: "X",
      company_id: [i + 1, `Co${i + 1}`] as [number, string],
    }));
    const msg = formatMultiMatchError(field, { name: "X" }, records);
    expect(msg).toContain('"Co1"');
    expect(msg).toContain('"Co5"');
    expect(msg).not.toContain('"Co6"');
    expect(msg).toMatch(/\+3 more/);
  });
});

describe("odoo_list_models", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns only models with read permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_list_models", agentId)!;
    expect(tool).toBeTruthy();

    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text) as {
      models: Array<{ model: string; name: string; operations: string[] }>;
    };
    expect(data.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "res.partner" }),
      ]),
    );
    expect(data.models.length).toBeGreaterThan(0);
  });

  it("returns empty when agent has no permissions", async () => {
    const tools = createApi({ [agentId]: { ...agentConfig, permissions: {} } });
    const tool = findTool(tools, "odoo_list_models", agentId)!;
    expect(tool).toBeTruthy();
    const result = await tool.execute("call-1", {});
    const data = JSON.parse(result.content[0].text) as { models: unknown[] };
    expect(data.models).toEqual([]);
  });
});

describe("tool registration", () => {
  it("registers all 18 tools (including the deprecated odoo_schema alias)", () => {
    const tools = createApi({ [agentId]: agentConfig });
    expect(tools).toHaveLength(18);
    const names = tools.map((t) => t.name);
    expect(names).toContain("odoo_list_models");
    expect(names).toContain("odoo_describe_model");
    expect(names).toContain("odoo_schema");
    expect(names).toContain("odoo_read");
    expect(names).toContain("odoo_count");
    expect(names).toContain("odoo_aggregate");
    expect(names).toContain("odoo_create");
    expect(names).toContain("odoo_schedule_activity");
    expect(names).toContain("odoo_complete_activity");
    expect(names).toContain("odoo_reschedule_activity");
    expect(names).toContain("odoo_confirm_order");
    expect(names).toContain("odoo_apply_inventory");
    expect(names).toContain("odoo_validate_picking");
    expect(names).toContain("odoo_mark_mo_done");
    expect(names).toContain("odoo_set_approval");
    expect(names).toContain("odoo_write");
    expect(names).toContain("odoo_delete");
    expect(names).toContain("odoo_attach_file");
  });

  it("returns null for all tools when no agentId", () => {
    const tools = createApi({ [agentId]: agentConfig });
    for (const tool of tools) {
      expect(tool.factory({})).toBeNull();
    }
  });

  it("returns null for all tools when agent has no config", () => {
    const tools = createApi({ [agentId]: agentConfig });
    for (const tool of tools) {
      expect(tool.factory({ agentId: "unknown-agent" })).toBeNull();
    }
  });
});

describe("odoo_describe_model", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects calls without a model parameter", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId)!;
    expect(tool).toBeTruthy();

    const result = await tool.execute("call-1", {});
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/model.*required/i);
  });

  it("returns compact field map for a permitted model", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer" },
      { name: "name", type: "char" },
      { name: "partner_id", type: "many2one", relation: "res.partner" },
    ]);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId)!;

    const result = await tool.execute("call-1", { model: "res.partner" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as {
      model: string;
      fields: Record<string, unknown>;
      _meta: { total: number; returned: number; truncated: boolean };
    };
    expect(data.model).toBe("res.partner");
    expect(data.fields).toBeDefined();
    expect(data._meta).toBeDefined();
    expect(data._meta.returned).toBeGreaterThan(0);
  });

  it("denies access to unpermitted models", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId)!;

    const result = await tool.execute("call-1", { model: "stock.move" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available/i);
  });

  // Issue #377: tool description itself should call out the distinction
  // between `id` and `default_code` so the LLM picks the right field even
  // before it has read any model's schema. Directional assertions — a typo
  // that swapped which field is the SKU would still match `/default_code/`
  // and `/SKU/i` individually but would fail the ordered phrases below.
  it("tool description disambiguates id from default_code", () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId)!;
    // `id` is described as NOT-the-SKU.
    expect(tool.description).toMatch(/`id`[^.]*NOT the SKU/);
    // SKU / internal reference IS `default_code`.
    expect(tool.description).toMatch(
      /(SKU|internal reference)[^.]*`default_code`/i,
    );
  });
});

describe("odoo_schema deprecated alias", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is still registered as a tool for backwards compatibility", () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = tools.find((t) => t.name === "odoo_schema");
    expect(tool).toBeDefined();
  });

  it("when called without a model parameter, behaves like odoo_list_models", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_schema", agentId)!;

    const result = await tool.execute("call-1", {});
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as {
      models: Array<{ model: string; name: string }>;
    };
    expect(data.models).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ model: "res.partner" }),
      ]),
    );
  });

  it("when called with a model parameter, returns the compact describe payload", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer" },
      { name: "name", type: "char" },
    ]);
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_schema", agentId)!;

    const result = await tool.execute("call-1", { model: "res.partner" });
    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text) as {
      model: string;
      fields: Record<string, string>;
      _meta: { total: number; returned: number; truncated: boolean };
    };
    expect(data.model).toBe("res.partner");
    expect(data._meta.returned).toBeGreaterThan(0);
    // The whole point of the v0.5.4 split: even when called via the deprecated
    // alias, the response uses the compact map format (not the verbose Odoo
    // metadata dump that exploded gemini-3-flash-preview's input budget).
    expect(typeof data.fields.id).toBe("string");
    expect(data.fields.id).toBe("int");
  });

  it("denies access to unpermitted models (alias enforces the same permissions)", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_schema", agentId)!;

    const result = await tool.execute("call-1", { model: "stock.move" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not available/i);
  });
});

// Issue #377: the shared product-ref disambiguation hint is spliced verbatim
// into every filter-accepting tool's description (odoo_read, odoo_count,
// odoo_aggregate). Each consumer test asserts `.toContain(...)` on the
// constant, so those tests would *also* pass if a future edit swapped the
// rule inside the constant itself. This block pins the rule direction
// directly on the constant so that swap-typo fails here loudly.
describe("PRODUCT_REF_DISAMBIGUATION_HINT (issue #377)", () => {
  it("directs SKU / internal-reference wording to `default_code` (not `id`)", () => {
    expect(PRODUCT_REF_DISAMBIGUATION_HINT).toMatch(
      /(SKU|internal reference)[^.]*`default_code`/i,
    );
  });

  it("directs 'record ID' / 'URL' wording to `id` (not `default_code`)", () => {
    expect(PRODUCT_REF_DISAMBIGUATION_HINT).toMatch(
      /(record ID|URL)[^.]*`id`/i,
    );
  });

  it("contains the explicit anti-direction `default_code`, not `id`", () => {
    expect(PRODUCT_REF_DISAMBIGUATION_HINT).toMatch(/`default_code`, not `id`/);
  });
});

describe("odoo_read", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  // Issue #377: when a user references "the SKU" or "internal reference" the
  // model frequently filters by `id` (the numeric DB primary key) and silently
  // returns nothing. The tool description should steer the model toward
  // `default_code` for human-given references. We assert the shared
  // disambiguation hint is present verbatim — directional correctness of the
  // hint itself is pinned by the dedicated `PRODUCT_REF_DISAMBIGUATION_HINT`
  // suite below, so a typo'd swap would fail there, not silently here.
  it("tool description includes the shared product-ref disambiguation hint", () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;
    expect(tool.description).toContain(PRODUCT_REF_DISAMBIGUATION_HINT);
  });

  it("reads records with correct parameters", async () => {
    mockSearchRead.mockResolvedValue({
      records: [{ id: 1, name: "SO001" }],
      total: 1,
      limit: 100,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [["state", "=", "sale"]],
      fields: ["name", "amount_total"],
      limit: 10,
      offset: 0,
      order: "date_order desc",
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.records).toHaveLength(1);
    expect(data.total).toBe(1);

    expect(mockSearchRead).toHaveBeenCalledWith(
      "sale.order",
      [["state", "=", "sale"]],
      {
        fields: ["name", "amount_total"],
        limit: 10,
        offset: 0,
        order: "date_order desc",
      },
    );
  });

  it("denies read on unpermitted model", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-2", {
      model: "account.move",
      filters: [],
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("account.move");
    expect(result.isError).toBe(true);
    expect(mockSearchRead).not.toHaveBeenCalled();
  });

  it("returns many2one values as opaque refs with labels", async () => {
    mockFields.mockResolvedValue([
      { name: "id", string: "ID", type: "integer" },
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [{ id: 7, name: "Wien Partner", country_id: [14, "Austria"] }],
      total: 1,
      limit: 100,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-ref-read", {
      model: "res.partner",
      filters: [],
      fields: ["name", "country_id"],
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.records[0].country_id).toEqual({
      ref: expect.stringMatching(/^pinchy_ref:v1:/),
      label: "Austria",
      model: "res.country",
    });
  });

  it("emits self-ref AND wraps m2o values on the same record (regression-guard)", async () => {
    // Self-ref emission and m2o-field wrapping share `wrapReadResult`. A
    // future refactor that re-orders the field loop or short-circuits could
    // silently drop one. Assert both survive on the same record.
    mockFields.mockResolvedValue([
      { name: "id", string: "ID", type: "integer" },
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [{ id: 7, name: "Wien Partner", country_id: [14, "Austria"] }],
      total: 1,
      limit: 100,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-combined", {
      model: "res.partner",
      filters: [],
      fields: ["name", "country_id"],
    });

    const data = JSON.parse(result.content[0].text);
    const record = data.records[0];

    // Self-ref present and decodes to this record
    expect(record._pinchy_ref).toMatch(/^pinchy_ref:v1:/);
    const selfDecoded = decodeRef(record._pinchy_ref);
    expect(selfDecoded.model).toBe("res.partner");
    expect(selfDecoded.id).toBe(7);

    // m2o still wrapped (not collapsed by self-ref logic)
    expect(record.country_id).toEqual({
      ref: expect.stringMatching(/^pinchy_ref:v1:/),
      label: "Austria",
      model: "res.country",
    });
    expect(record.country_id.ref).not.toBe(record._pinchy_ref);
  });

  it("attaches a `_pinchy_ref` self-ref to every returned record", async () => {
    // Symmetric with odoo_create: every record the LLM sees should have a
    // ref it can pass to tools like odoo_attach_file. Without this, an
    // agent that reads an existing account.move and then wants to attach
    // a receipt to it has no way to obtain the targetRef.
    mockFields.mockResolvedValue([
      { name: "id", string: "ID", type: "integer" },
      { name: "name", string: "Name", type: "char" },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 11, name: "Partner A" },
        { id: 22, name: "Partner B" },
      ],
      total: 2,
      limit: 100,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-self-ref-read", {
      model: "res.partner",
      filters: [],
      fields: ["name"],
    });

    const data = JSON.parse(result.content[0].text) as {
      records: Array<{ id: number; _pinchy_ref: string }>;
    };
    expect(data.records).toHaveLength(2);

    for (const r of data.records) {
      expect(r._pinchy_ref).toMatch(/^pinchy_ref:v1:/);
      const decoded = decodeRef(r._pinchy_ref);
      expect(decoded.model).toBe("res.partner");
      expect(decoded.id).toBe(r.id);
    }
  });

  it("uses display_name as the read-record ref label when present, otherwise name, otherwise `<model>#<id>`", async () => {
    mockFields.mockResolvedValue([
      { name: "id", string: "ID", type: "integer" },
      { name: "name", string: "Name", type: "char" },
      { name: "display_name", string: "Display Name", type: "char" },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 1, name: "Plain Name", display_name: "Fancy Display" },
        { id: 2, name: "Only Name" },
        { id: 3 },
      ],
      total: 3,
      limit: 100,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-label-fallback", {
      model: "res.partner",
      filters: [],
      fields: ["name", "display_name"],
    });

    const data = JSON.parse(result.content[0].text) as {
      records: Array<{ id: number; _pinchy_ref: string }>;
    };
    expect(decodeRef(data.records[0]._pinchy_ref).label).toBe("Fancy Display");
    expect(decodeRef(data.records[1]._pinchy_ref).label).toBe("Only Name");
    expect(decodeRef(data.records[2]._pinchy_ref).label).toBe("res.partner#3");
  });
});

describe("odoo_count", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Issue #377: `odoo_count` accepts the same domain-filter shape as
  // `odoo_read`, so an agent counting `[["id", "=", "WIDGET-12"]]` silently
  // returns 0 with no signal that it should have used `default_code`. The
  // description should carry the same shared disambiguation hint.
  it("tool description includes the shared product-ref disambiguation hint", () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId)!;
    expect(tool.description).toContain(PRODUCT_REF_DISAMBIGUATION_HINT);
  });

  it("counts records for a permitted model", async () => {
    mockSearchCount.mockResolvedValue(42);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [["state", "=", "sale"]],
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.count).toBe(42);
    expect(mockSearchCount).toHaveBeenCalledWith("sale.order", [
      ["state", "=", "sale"],
    ]);
  });

  it("denies count on unpermitted model", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId)!;

    const result = await tool.execute("call-2", {
      model: "account.move",
      filters: [],
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
  });
});

describe("odoo_aggregate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Issue #377: same domain-filter shape as `odoo_read`/`odoo_count` — an
  // agent grouping by `id` when the user said "the SKU" silently aggregates
  // the wrong dimension. Description carries the same shared disambiguation
  // hint.
  it("tool description includes the shared product-ref disambiguation hint", () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_aggregate", agentId)!;
    expect(tool.description).toContain(PRODUCT_REF_DISAMBIGUATION_HINT);
  });

  it("aggregates data for a permitted model", async () => {
    mockReadGroup.mockResolvedValue({
      groups: [
        { partner_id: [1, "Customer A"], amount_total: 1500, __count: 3 },
      ],
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_aggregate", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
      fields: ["partner_id", "amount_total:sum"],
      groupby: ["partner_id"],
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.groups).toHaveLength(1);
    expect(mockReadGroup).toHaveBeenCalledWith(
      "sale.order",
      [],
      ["partner_id", "amount_total:sum"],
      ["partner_id"],
      { limit: undefined, offset: undefined, orderby: undefined },
    );
  });

  it("denies aggregation on unpermitted model", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_aggregate", agentId)!;

    const result = await tool.execute("call-2", {
      model: "account.move",
      filters: [],
      fields: ["amount_total:sum"],
      groupby: ["partner_id"],
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
  });
});

describe("odoo_create", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  it("creates a record on a permitted model", async () => {
    mockCreate.mockResolvedValue(42);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-1", {
      model: "res.partner",
      values: { name: "New Partner", email: "new@example.com" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe(42);
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "New Partner",
      email: "new@example.com",
    });
  });

  it("returns a `_pinchy_ref` self-ref alongside the id", async () => {
    mockCreate.mockResolvedValue(42);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-1", {
      model: "res.partner",
      values: { name: "New Partner" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data._pinchy_ref).toBeDefined();
    expect(typeof data._pinchy_ref).toBe("string");
    expect(data._pinchy_ref).toMatch(/^pinchy_ref:v1:/);

    const decoded = decodeRef(data._pinchy_ref);
    expect(decoded).toEqual({
      integrationType: "odoo",
      connectionId: agentConfig.connectionId,
      model: "res.partner",
      id: 42,
      label: "New Partner",
    });
  });

  it("falls back to values.display_name as the ref label when values.name is missing", async () => {
    mockCreate.mockResolvedValue(7);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-1", {
      model: "res.partner",
      values: { display_name: "Display Only" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(decodeRef(data._pinchy_ref).label).toBe("Display Only");
  });

  it("falls back to `<model>#<id>` as the ref label when no name is provided", async () => {
    mockCreate.mockResolvedValue(9);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-1", {
      model: "res.partner",
      // No name / display_name in values — exercise the fallback path.
      values: { email: "x@example.com" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(decodeRef(data._pinchy_ref).label).toBe("res.partner#9");
  });

  it("ref returned by odoo_create is accepted as targetRef by odoo_attach_file", async () => {
    // Regression for the v0.5.4 staging bug: an LLM creating a record and
    // chaining odoo_attach_file with the returned ref must succeed without
    // any "Invalid integration reference" rejection. This guards the
    // round-trip surface — encode in odoo_create, decode in odoo_attach_file.
    mockCreate.mockResolvedValue(99);

    const tools = createApi({ [agentId]: agentConfig });
    const create = findTool(tools, "odoo_create", agentId)!;
    const createRes = await create.execute("call-1", {
      model: "res.partner",
      values: { name: "Round-Trip" },
    });
    const { _pinchy_ref: ref } = JSON.parse(createRes.content[0].text) as {
      _pinchy_ref: string;
    };

    expect(() => decodeRef(ref)).not.toThrow();
    const decoded = decodeRef(ref);
    expect(decoded.model).toBe("res.partner");
    expect(decoded.id).toBe(99);
  });

  it("resolves country_id by exact country name instead of using the first same-letter country", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 1, name: "Aruba", code: "AW" },
        { id: 14, name: "Austria", code: "AT" },
      ],
      total: 2,
      limit: 1000,
      offset: 0,
    });
    mockCreate.mockResolvedValue(42);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-name", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: "Austria" },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "Wien Partner",
      country_id: 14,
    });
  });

  it("rejects raw numeric country_id values", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-raw-id", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: 14 },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "Raw numeric IDs are not accepted",
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("resolves country_id from an explicit code lookup", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 1, name: "Aruba", code: "AW" },
        { id: 14, name: "Austria", code: "AT" },
      ],
      total: 2,
      limit: 1000,
      offset: 0,
    });
    mockCreate.mockResolvedValue(44);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-code-lookup", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: { lookup: { code: "AT" } } },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "Wien Partner",
      country_id: 14,
    });
  });

  it("resolves country_id from an opaque ref", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockCreate.mockResolvedValue(45);
    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.country",
      id: 14,
      label: "Austria",
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-ref", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: { ref } },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "Wien Partner",
      country_id: 14,
    });
  });

  it("rejects an opaque ref for the wrong relation model", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.partner",
      id: 7,
      label: "Wien Partner",
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-wrong-ref", {
      model: "res.partner",
      values: { name: "Wien Partner", country_id: { ref } },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("expected res.country");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("resolves USA as the United States country code instead of the first U country", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 230, name: "Uzbekistan", code: "UZ" },
        { id: 233, name: "United States", code: "US" },
      ],
      total: 2,
      limit: 1000,
      offset: 0,
    });
    mockCreate.mockResolvedValue(43);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-usa", {
      model: "res.partner",
      values: { name: "US Partner", country_id: "USA" },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "US Partner",
      country_id: 233,
    });
  });

  it("rejects ambiguous country text instead of creating with an arbitrary match", async () => {
    mockFields.mockResolvedValue([
      { name: "name", string: "Name", type: "char" },
      {
        name: "country_id",
        string: "Country",
        type: "many2one",
        relation: "res.country",
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 220, name: "Uganda", code: "UG" },
        { id: 230, name: "Uzbekistan", code: "UZ" },
      ],
      total: 2,
      limit: 1000,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-country-ambiguous", {
      model: "res.partner",
      values: { name: "Unknown Partner", country_id: "U" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Could not resolve country_id");
    expect(result.content[0].text).toContain("Uganda");
    expect(result.content[0].text).toContain("Uzbekistan");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("denies create on model without create permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-2", {
      model: "sale.order",
      values: { name: "SO999" },
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.content[0].text).toContain("create");
    expect(result.isError).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  // Regression guard: some LLMs (observed with ollama-cloud/gemini-3-flash-preview
  // on the v0.5.4 staging click-through) emit tool_call arguments where the keys
  // of object-valued args contain literal JSON-escaped quotes — e.g.
  //   values: { "\"name\"": "Tesla", "\"city\"": "Wien" }
  // instead of
  //   values: { "name": "Tesla", "city": "Wien" }
  // Without sanitization those quotes reach Odoo verbatim and create() rejects
  // every record because no field "\"name\"" exists.
  it("strips literal JSON-escaped quotes from value keys before create()", async () => {
    mockCreate.mockResolvedValue(99);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-quoted-keys", {
      model: "res.partner",
      values: {
        '"name"': "Tesla Motors Austria GmbH",
        '"vat"': "ATU67878139",
        '"city"': "Wien",
        '"is_company"': true,
      },
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("res.partner", {
      name: "Tesla Motors Austria GmbH",
      vat: "ATU67878139",
      city: "Wien",
      is_company: true,
    });
  });

  it("description documents price_unit net convention for invoice/order line models", () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;
    expect(tool.description).toMatch(/price_unit`[^.]{0,80}tax-exclusive/i);
  });
});

describe("odoo_write", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("updates records on a permitted model", async () => {
    mockWrite.mockResolvedValue(true);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_write", agentId)!;

    const result = await tool.execute("call-1", {
      model: "res.partner",
      ids: [1, 2],
      values: { email: "updated@example.com" },
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(mockWrite).toHaveBeenCalledWith("res.partner", [1, 2], {
      email: "updated@example.com",
    });
  });

  it("denies write on model without write permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_write", agentId)!;

    const result = await tool.execute("call-2", {
      model: "sale.order",
      ids: [1],
      values: { name: "updated" },
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  // Nested-record variant of the gemini-3-flash-preview regression: Odoo's
  // x2many command tuples wrap fresh records as `[0, 0, {…}]`, and gemini
  // applies the same quote-wrapping bug to the inner record's keys too.
  // Without recursive sanitization the outer field passes but the line never
  // materialises in Odoo, which causes a write retry loop on staging.
  it("strips quote-wrapped keys recursively from nested x2many records", async () => {
    mockWrite.mockResolvedValue(true);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_write", agentId)!;

    const result = await tool.execute("call-nested-quotes", {
      model: "res.partner",
      ids: [42],
      values: {
        '"name"': "Tesla",
        '"child_ids"': [
          [0, 0, { '"name"': "Contact 1", '"email"': "a@example.com" }],
        ],
      },
    });

    expect(result.isError).toBeFalsy();
    expect(mockWrite).toHaveBeenCalledWith("res.partner", [42], {
      name: "Tesla",
      child_ids: [[0, 0, { name: "Contact 1", email: "a@example.com" }]],
    });
  });

  // Same regression guard as odoo_create — see comment above the create test.
  it("strips literal JSON-escaped quotes from value keys before write()", async () => {
    mockWrite.mockResolvedValue(true);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_write", agentId)!;

    const result = await tool.execute("call-quoted-keys", {
      model: "res.partner",
      ids: [42],
      values: { '"email"': "updated@example.com", '"city"': "Linz" },
    });

    expect(result.isError).toBeFalsy();
    expect(mockWrite).toHaveBeenCalledWith("res.partner", [42], {
      email: "updated@example.com",
      city: "Linz",
    });
  });

  it("description documents price_unit net convention for invoice/order line models", () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_write", agentId)!;
    expect(tool.description).toMatch(/price_unit`[^.]{0,80}tax-exclusive/i);
  });
});

describe("odoo_delete", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes records on a permitted model", async () => {
    mockUnlink.mockResolvedValue(true);

    // Add delete permission for this test
    const configWithDelete = {
      ...agentConfig,
      permissions: {
        ...testPermissions,
        "res.partner": ["read", "write", "create", "delete"],
      },
    };
    const tools = createApi({ [agentId]: configWithDelete });
    const tool = findTool(tools, "odoo_delete", agentId)!;

    const result = await tool.execute("call-1", {
      model: "res.partner",
      ids: [5, 6],
    });

    const data = JSON.parse(result.content[0].text);
    expect(data.success).toBe(true);
    expect(mockUnlink).toHaveBeenCalledWith("res.partner", [5, 6]);
  });

  it("denies delete on model without delete permission", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_delete", agentId)!;

    const result = await tool.execute("call-2", {
      model: "res.partner",
      ids: [1],
    });

    expect(result.content[0].text).toContain("Permission denied");
    expect(result.isError).toBe(true);
    expect(mockUnlink).not.toHaveBeenCalled();
  });
});

describe("error handling", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns error message when Odoo client throws", async () => {
    mockSearchRead.mockRejectedValue(new Error("Connection refused"));

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.content[0].text).toContain("Error: Connection refused");
    expect(result.isError).toBe(true);
  });

  // Audit-integrity contract: OpenClaw strips the MCP `isError` flag before
  // forwarding tool results to /api/internal/audit/tool-use (OC bug #404), so
  // the audit endpoint falls back to `result.details.error` to record a
  // failure. Without it, a failed odoo tool call is logged as outcome=success
  // (the 2026-06-25 false-success incident: vendor-bill creates threw on an
  // ambiguous partner, never reached Odoo, yet were audited as success).
  it("attaches details.error on a client-thrown error so the audit records a failure even when OpenClaw strips isError", async () => {
    mockSearchRead.mockRejectedValue(new Error("Connection refused"));

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.isError).toBe(true);
    expect((result.details as { error?: string } | undefined)?.error).toContain(
      "Connection refused",
    );
  });

  it("attaches details.error on a permission-denied result", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_create", agentId)!;

    // sale.order grants only "read" in testPermissions → create is denied.
    const result = await tool.execute("call-1", {
      model: "sale.order",
      values: { name: "Should not be created" },
    });

    expect(result.isError).toBe(true);
    expect((result.details as { error?: string } | undefined)?.error).toContain(
      "Permission denied",
    );
  });

  it("attaches details.error on an inline validation error (odoo_describe_model without model)", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_describe_model", agentId)!;

    const result = await tool.execute("call-1", {});

    expect(result.isError).toBe(true);
    expect((result.details as { error?: string } | undefined)?.error).toMatch(
      /model.*required/i,
    );
  });

  it("attaches details.error on an inline validation error (odoo_attach_file invalid filename)", async () => {
    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_attach_file", agentId)!;

    const result = await tool.execute("call-1", {
      filename: "../../etc/passwd",
      targetRef: "x",
    });

    expect(result.isError).toBe(true);
    expect((result.details as { error?: string } | undefined)?.error).toContain(
      "Invalid filename",
    );
  });

  it("returns permission message for Odoo access errors", async () => {
    mockSearchRead.mockRejectedValue(
      new Error("AccessError: no read access on sale.order"),
    );

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.content[0].text).toContain("denied permission");
    expect(result.isError).toBe(true);
  });

  it("does not treat 'Failed to access host' as a permission error", async () => {
    mockSearchRead.mockRejectedValue(new Error("Failed to access host"));

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.content[0].text).not.toContain("denied permission");
    expect(result.content[0].text).toContain("Error: Failed to access host");
    expect(result.isError).toBe(true);
  });

  it("handles non-Error throws gracefully", async () => {
    mockSearchRead.mockRejectedValue("string error");

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.content[0].text).toContain("Error: Unknown error");
    expect(result.isError).toBe(true);
  });
});

describe("client caching (#209 layer 2: credentials fetched lazily, cached)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ type: "odoo", credentials: testCredentials }),
    } as unknown as Response);
  });

  it("fetches credentials once and reuses the OdooClient across multiple tool calls for the same agent", async () => {
    mockSearchRead.mockResolvedValue({
      records: [],
      total: 0,
      limit: 100,
      offset: 0,
    });
    mockSearchCount.mockResolvedValue(0);

    const tools = createApi({ [agentId]: agentConfig });
    const readTool = findTool(tools, "odoo_read", agentId)!;
    const countTool = findTool(tools, "odoo_count", agentId)!;

    await readTool.execute("call-1", { model: "sale.order", filters: [] });
    await readTool.execute("call-2", { model: "sale.order", filters: [] });
    await countTool.execute("call-3", { model: "sale.order", filters: [] });

    // Credentials API hit exactly once across the 3 tool calls
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // OdooClient constructor called exactly once (cached client reused)
    expect(OdooClient).toHaveBeenCalledTimes(1);
  });

  it("fetches credentials separately for different agents (no cross-agent leakage)", async () => {
    mockSearchRead.mockResolvedValue({
      records: [],
      total: 0,
      limit: 100,
      offset: 0,
    });

    const agent2Config = {
      connectionId: "conn-test-2",
      permissions: testPermissions,
    };
    const tools = createApi({
      [agentId]: agentConfig,
      "agent-2": agent2Config,
    });

    const tool1 = findTool(tools, "odoo_read", agentId)!;
    const tool2 = findTool(tools, "odoo_read", "agent-2")!;

    await tool1.execute("call-1", { model: "sale.order", filters: [] });
    await tool2.execute("call-2", { model: "sale.order", filters: [] });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(OdooClient).toHaveBeenCalledTimes(2);
    // Each fetch hit the connectionId-specific path
    const urls = fetchMock.mock.calls.map((c) => String(c[0]));
    expect(urls.some((u) => u.includes("conn-test-1"))).toBe(true);
    expect(urls.some((u) => u.includes("conn-test-2"))).toBe(true);
  });

  it("fails fast with a clear error if the credentials API returns the SecretRef object shape (#209 regression)", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        type: "odoo",
        // Exactly the broken shape from staging: an unresolved SecretRef.
        credentials: {
          source: "file",
          provider: "pinchy",
          id: "/integrations/x/odooApiKey",
        },
      }),
    } as unknown as Response);

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_count", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("must be a string");
    expect(text).toContain("#209");
  });

  it("invalidates the cache and refetches credentials on auth error", async () => {
    mockSearchRead.mockRejectedValueOnce(
      new Error("Access Denied: invalid api key"),
    );
    mockSearchRead.mockResolvedValueOnce({
      records: [],
      total: 0,
      limit: 100,
      offset: 0,
    });

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-1", {
      model: "sale.order",
      filters: [],
    });

    expect(result.isError).toBeFalsy();
    // First call fetched, error invalidated cache, second call refetched
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(mockSearchRead).toHaveBeenCalledTimes(2);
  });

  it("POSTs report-auth-failure when retry-once also returns an auth error", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ type: "odoo", credentials: testCredentials }),
    } as unknown as Response);

    mockSearchRead
      .mockRejectedValueOnce(new Error("Access Denied: invalid api key"))
      .mockRejectedValueOnce(new Error("Access Denied: invalid api key"));

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    await tool.execute("call-1", { model: "sale.order", filters: [] });

    const reportCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("report-auth-failure"),
    );
    expect(reportCalls).toHaveLength(1);
    const [url, opts] = reportCalls[0] as [string, RequestInit];
    expect(url).toBe(
      "http://pinchy-test:7777/api/internal/integrations/conn-test-1/report-auth-failure",
    );
    expect(opts.method).toBe("POST");
    const headers = opts.headers as Record<string, string>;
    expect(headers["Authorization"]).toBe("Bearer test-gateway-token");
    expect(headers["X-Plugin-Id"]).toBe("pinchy-odoo");
    const body = JSON.parse(opts.body as string) as { reason: string };
    expect(body.reason).toBeTruthy();
  });

  it("does not POST report-auth-failure on a transient 5xx error", async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ type: "odoo", credentials: testCredentials }),
    } as unknown as Response);

    mockSearchRead.mockRejectedValueOnce(
      new Error("HTTP 503 Service Unavailable"),
    );

    const tools = createApi({ [agentId]: agentConfig });
    const tool = findTool(tools, "odoo_read", agentId)!;

    await tool.execute("call-1", { model: "sale.order", filters: [] });

    const reportCalls = fetchMock.mock.calls.filter((c) =>
      String(c[0]).includes("report-auth-failure"),
    );
    expect(reportCalls).toHaveLength(0);
  });
});

describe("odoo_attach_file", () => {
  const attachAgentId = "agent-attach-1";
  const attachAgentConfig = {
    connectionId: "conn-test-1",
    permissions: {
      "account.move": ["read", "write", "create"],
      "ir.attachment": ["read", "create"],
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
    // Default: small file (1 KB). Override per-test for size-limit checks.
    mockStat.mockResolvedValue({ size: 1024 });
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({ type: "odoo", credentials: testCredentials }),
    });
  });

  it("attaches a file to a record and returns an encrypted ref", async () => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 42,
      label: "INV/2025/0001",
    });

    const fakeBytes = Buffer.from("fake-image-bytes");
    mockReadFile.mockResolvedValue(fakeBytes);
    mockCreate.mockResolvedValue(99);

    const tools = createApi({ [attachAgentId]: attachAgentConfig });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;
    expect(tool).not.toBeNull();

    const result = await tool.execute("call-1", {
      targetRef,
      filename: "receipt.jpg",
    });

    expect(result.isError).toBeFalsy();
    const data = JSON.parse(result.content[0].text);
    expect(data.ref).toMatch(/^pinchy_ref:v1:/);
    expect(data.name).toBe("receipt.jpg");
    expect(data.mimetype).toBe("image/jpeg");

    expect(mockCreate).toHaveBeenCalledWith("ir.attachment", {
      res_model: "account.move",
      res_id: 42,
      name: "receipt.jpg",
      datas: fakeBytes.toString("base64"),
      mimetype: "image/jpeg",
    });

    expect(mockReadFile).toHaveBeenCalledWith(
      `/root/.openclaw/workspaces/${attachAgentId}/uploads/receipt.jpg`,
    );
  });

  it("rejects a targetRef minted for a DIFFERENT connection (tenant isolation)", async () => {
    // A ref for conn-test-2 decodes validly under the shared per-deployment ref
    // key, but this agent is bound to conn-test-1 — it must be refused before
    // any ir.attachment create, matching every sibling ref-consuming tool.
    const foreignRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-2",
      model: "account.move",
      id: 42,
      label: "INV/2025/0001",
    });
    mockReadFile.mockResolvedValue(Buffer.from("x"));

    const tools = createApi({ [attachAgentId]: attachAgentConfig });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    const result = await tool.execute("call-foreign", {
      targetRef: foreignRef,
      filename: "receipt.jpg",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "does not belong to this Odoo connection",
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns permission denied when ir.attachment.create is missing", async () => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 42,
      label: "INV/2025/0001",
    });

    const configNoAttach = {
      connectionId: "conn-test-1",
      permissions: {
        "account.move": ["read", "write", "create"],
        // no ir.attachment entry
      },
    };

    const tools = createApi({ [attachAgentId]: configNoAttach });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    const result = await tool.execute("call-1", {
      targetRef,
      filename: "receipt.jpg",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns permission denied when targetModel.write is missing", async () => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 42,
      label: "INV/2025/0001",
    });

    const configReadOnly = {
      connectionId: "conn-test-1",
      permissions: {
        "account.move": ["read"],
        "ir.attachment": ["read", "create"],
      },
    };

    const tools = createApi({ [attachAgentId]: configReadOnly });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    const result = await tool.execute("call-1", {
      targetRef,
      filename: "receipt.jpg",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("returns an error when the file does not exist", async () => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 42,
      label: "INV/2025/0001",
    });

    const notFound = Object.assign(new Error("ENOENT: no such file"), {
      code: "ENOENT",
    });
    mockStat.mockRejectedValue(notFound);

    const tools = createApi({ [attachAgentId]: attachAgentConfig });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    const result = await tool.execute("call-1", {
      targetRef,
      filename: "missing.jpg",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("missing.jpg");
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it("returns an error for an invalid targetRef", async () => {
    const tools = createApi({ [attachAgentId]: attachAgentConfig });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    const result = await tool.execute("call-1", {
      targetRef: "not-a-valid-ref",
      filename: "receipt.jpg",
    });

    expect(result.isError).toBe(true);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it.each([
    ["receipt.jpg", "image/jpeg"],
    ["scan.jpeg", "image/jpeg"],
    ["photo.png", "image/png"],
    ["anim.gif", "image/gif"],
    ["modern.webp", "image/webp"],
    ["document.pdf", "application/pdf"],
    ["unknown.xyz", "application/octet-stream"],
  ])("detects MIME type for %s as %s", async (filename, expectedMime) => {
    const targetRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.move",
      id: 1,
      label: "INV",
    });
    mockReadFile.mockResolvedValue(Buffer.from("bytes"));
    mockCreate.mockResolvedValue(1);

    const tools = createApi({ [attachAgentId]: attachAgentConfig });
    const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

    await tool.execute("call-1", { targetRef, filename });

    expect(mockCreate).toHaveBeenCalledWith(
      "ir.attachment",
      expect.objectContaining({ mimetype: expectedMime }),
    );
  });

  // Security: prevents prompt-injection-driven file exfiltration. A
  // compromised agent could otherwise request `filename: "../../etc/passwd"`
  // and the plugin would attach arbitrary container files to an Odoo record.
  describe("filename validation (prevents path traversal)", () => {
    const validTargetRef = () =>
      encodeRef({
        integrationType: "odoo",
        connectionId: "conn-test-1",
        model: "account.move",
        id: 42,
        label: "INV/2025/0001",
      });

    it.each([
      ["../etc/passwd", "parent directory traversal"],
      ["../../etc/passwd", "deep parent traversal"],
      ["/etc/passwd", "absolute path"],
      ["subdir/file.txt", "subdirectory"],
      [".env", "hidden file"],
      ["..", "just dots"],
      [".", "single dot"],
      ["..\\windows\\system32", "Windows-style backslash traversal"],
    ])('rejects filename "%s" (%s)', async (badFilename) => {
      mockReadFile.mockResolvedValue(Buffer.from("bytes"));
      mockCreate.mockResolvedValue(1);

      const tools = createApi({ [attachAgentId]: attachAgentConfig });
      const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

      const result = await tool.execute("call-1", {
        targetRef: validTargetRef(),
        filename: badFilename,
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/invalid filename/i);
      expect(mockStat).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("accepts a plain filename with spaces, digits, and dashes", async () => {
      mockReadFile.mockResolvedValue(Buffer.from("bytes"));
      mockCreate.mockResolvedValue(7);

      const tools = createApi({ [attachAgentId]: attachAgentConfig });
      const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

      const result = await tool.execute("call-1", {
        targetRef: validTargetRef(),
        filename: "Receipt 2026-Q1.pdf",
      });

      expect(result.isError).toBeFalsy();
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  // Defense against memory exhaustion: readFile loads the entire file plus a
  // base64 representation into memory. Without an upper bound a single
  // upload could OOM the plugin process.
  describe("file size limit", () => {
    const validTargetRef = () =>
      encodeRef({
        integrationType: "odoo",
        connectionId: "conn-test-1",
        model: "account.move",
        id: 42,
        label: "INV/2025/0001",
      });

    it("rejects files larger than 25 MB", async () => {
      mockStat.mockResolvedValue({ size: 26 * 1024 * 1024 });
      mockReadFile.mockResolvedValue(Buffer.from("bytes"));
      mockCreate.mockResolvedValue(1);

      const tools = createApi({ [attachAgentId]: attachAgentConfig });
      const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

      const result = await tool.execute("call-1", {
        targetRef: validTargetRef(),
        filename: "huge.pdf",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toMatch(/too large/i);
      expect(mockReadFile).not.toHaveBeenCalled();
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it("accepts files at exactly 25 MB", async () => {
      mockStat.mockResolvedValue({ size: 25 * 1024 * 1024 });
      mockReadFile.mockResolvedValue(Buffer.from("bytes"));
      mockCreate.mockResolvedValue(1);

      const tools = createApi({ [attachAgentId]: attachAgentConfig });
      const tool = findTool(tools, "odoo_attach_file", attachAgentId)!;

      const result = await tool.execute("call-1", {
        targetRef: validTargetRef(),
        filename: "edge.pdf",
      });

      expect(result.isError).toBeFalsy();
      expect(mockCreate).toHaveBeenCalled();
    });
  });

  describe("odoo_create → odoo_attach_file end-to-end roundtrip", () => {
    // Production-relevant chain: agent creates a record, then attaches a
    // file to it using the ref returned by create. This regression-tested
    // the v0.5.4 staging bug where odoo_create's raw {id} response left
    // the LLM no path to a valid targetRef.
    it("chains odoo_create → odoo_attach_file via _pinchy_ref without manual ref construction", async () => {
      mockCreate
        .mockResolvedValueOnce(123) // odoo_create returns id 123 for account.move
        .mockResolvedValueOnce(456); // odoo_attach_file create for ir.attachment

      const tools = createApi({ [attachAgentId]: attachAgentConfig });
      const createTool = findTool(tools, "odoo_create", attachAgentId)!;
      const attachTool = findTool(tools, "odoo_attach_file", attachAgentId)!;

      // 1. Agent creates an account.move (vendor bill draft).
      const createResult = await createTool.execute("call-1", {
        model: "account.move",
        values: { move_type: "in_invoice", invoice_date: "2026-01-15" },
      });
      const createData = JSON.parse(createResult.content[0].text) as {
        id: number;
        _pinchy_ref: string;
      };
      expect(createData.id).toBe(123);
      expect(createData._pinchy_ref).toMatch(/^pinchy_ref:v1:/);

      // 2. Agent chains the _pinchy_ref directly into odoo_attach_file —
      //    no string construction, no raw ID guessing, no "<model>,<id>"
      //    notation. Just pass the opaque token verbatim.
      mockReadFile.mockResolvedValue(Buffer.from("invoice PDF bytes"));
      const attachResult = await attachTool.execute("call-2", {
        targetRef: createData._pinchy_ref,
        filename: "invoice.pdf",
      });

      expect(attachResult.isError).toBeFalsy();
      // ir.attachment was created against the same model+id from create
      expect(mockCreate).toHaveBeenLastCalledWith("ir.attachment", {
        res_model: "account.move",
        res_id: 123,
        name: "invoice.pdf",
        datas: expect.any(String),
        mimetype: "application/pdf",
      });
    });
  });
});

describe("odoo_read multi-company auto-include", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  it("auto-includes company_id when the model has the field and the LLM did not ask for it", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      { name: "code", type: "char", required: false, readonly: false },
      { name: "name", type: "char", required: false, readonly: false },
      {
        name: "company_id",
        type: "many2one",
        relation: "res.company",
        required: true,
        readonly: false,
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        {
          id: 42,
          code: "1000",
          name: "Wareneinsatz",
          company_id: [1, "GmbH A"],
        },
      ],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.account": ["read"] },
      },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;

    await tool.execute("call-1", {
      model: "account.account",
      filters: [],
      fields: ["code", "name"], // LLM did NOT ask for company_id
    });

    expect(mockSearchRead).toHaveBeenCalledWith(
      "account.account",
      [],
      expect.objectContaining({ fields: ["code", "name", "company_id"] }),
    );
  });

  it("does NOT auto-include company_id when the model lacks the field", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      { name: "code", type: "char", required: false, readonly: false },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [],
      total: 0,
      limit: 0,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: { ...agentConfig, permissions: { "res.country": ["read"] } },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;

    await tool.execute("call-2", {
      model: "res.country",
      filters: [],
      fields: ["code"],
    });

    expect(mockSearchRead).toHaveBeenCalledWith(
      "res.country",
      [],
      expect.not.objectContaining({
        fields: expect.arrayContaining(["company_id"]),
      }),
    );
  });

  it("does NOT duplicate company_id if the LLM already asked for it", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      {
        name: "company_id",
        type: "many2one",
        relation: "res.company",
        required: true,
        readonly: false,
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [],
      total: 0,
      limit: 0,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: { ...agentConfig, permissions: { "account.move": ["read"] } },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;

    await tool.execute("call-3", {
      model: "account.move",
      filters: [],
      fields: ["company_id", "name"],
    });

    expect(mockSearchRead).toHaveBeenCalledWith(
      "account.move",
      [],
      expect.objectContaining({ fields: ["company_id", "name"] }),
    );
  });

  it("leaves the LLM's fields list untouched when fields is undefined (all-fields mode)", async () => {
    mockFields.mockResolvedValue([
      {
        name: "company_id",
        type: "many2one",
        relation: "res.company",
        required: true,
        readonly: false,
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [],
      total: 0,
      limit: 0,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: { ...agentConfig, permissions: { "account.move": ["read"] } },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;

    await tool.execute("call-4", { model: "account.move", filters: [] }); // no fields

    expect(mockSearchRead).toHaveBeenCalledWith(
      "account.move",
      [],
      expect.objectContaining({ fields: undefined }),
    );
  });

  it("appends company suffix to the _pinchy_ref label when company_id is present", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      { name: "name", type: "char", required: false, readonly: false },
      { name: "display_name", type: "char", required: false, readonly: false },
      {
        name: "company_id",
        type: "many2one",
        relation: "res.company",
        required: true,
        readonly: false,
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        {
          id: 42,
          name: "Wareneinsatz",
          display_name: "1000 Wareneinsatz",
          company_id: [1, "GmbH A"],
        },
        {
          id: 87,
          name: "Wareneinsatz",
          display_name: "1000 Wareneinsatz",
          company_id: [2, "GmbH B"],
        },
      ],
      total: 2,
      limit: 2,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.account": ["read"] },
      },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-5", {
      model: "account.account",
      filters: [],
      fields: ["name", "display_name"],
    });

    const payload = JSON.parse(result.content[0].text);
    const refs = payload.records.map((r: { _pinchy_ref: string }) =>
      decodeRef(r._pinchy_ref),
    );
    expect(refs[0].label).toBe("1000 Wareneinsatz [GmbH A]");
    expect(refs[1].label).toBe("1000 Wareneinsatz [GmbH B]");
  });

  it("does NOT append the suffix when company_id is absent on the record", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      { name: "display_name", type: "char", required: false, readonly: false },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [{ id: 14, display_name: "Austria" }],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: { ...agentConfig, permissions: { "res.country": ["read"] } },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-6", {
      model: "res.country",
      filters: [],
      fields: ["display_name"],
    });
    const payload = JSON.parse(result.content[0].text);
    const label = decodeRef(payload.records[0]._pinchy_ref).label;
    expect(label).toBe("Austria");
    expect(label).not.toMatch(/\[.*\]$/);
  });

  it("does NOT append the suffix when company_id is false (single-company tenant)", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      { name: "display_name", type: "char", required: false, readonly: false },
      {
        name: "company_id",
        type: "many2one",
        relation: "res.company",
        required: false,
        readonly: false,
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [{ id: 99, display_name: "Generic Account", company_id: false }],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.account": ["read"] },
      },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;

    const result = await tool.execute("call-7", {
      model: "account.account",
      filters: [],
      fields: ["display_name"],
    });
    const payload = JSON.parse(result.content[0].text);
    const label = decodeRef(payload.records[0]._pinchy_ref).label;
    expect(label).toBe("Generic Account");
    expect(label).not.toMatch(/\[.*\]$/);
  });

  it("appends company suffix even when company_id is explicitly in the requested fields list (ordering invariant)", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      { name: "name", type: "char", required: false, readonly: false },
      { name: "display_name", type: "char", required: false, readonly: false },
      {
        name: "company_id",
        type: "many2one",
        relation: "res.company",
        required: true,
        readonly: false,
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        {
          id: 42,
          name: "Wareneinsatz",
          display_name: "1000 Wareneinsatz",
          company_id: [1, "GmbH A"],
        },
      ],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.account": ["read"] },
      },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;

    // company_id IS in the requested fields list, so the m2o-wrap loop will
    // transform it from [1, "GmbH A"] into {ref, label, model}. The self-ref's
    // label suffix must still pick up the company name — that only works if the
    // self-ref encoding reads record.company_id BEFORE the wrap loop runs.
    const result = await tool.execute("call-order", {
      model: "account.account",
      filters: [],
      fields: ["name", "display_name", "company_id"],
    });

    const payload = JSON.parse(result.content[0].text);
    const ref = decodeRef(payload.records[0]._pinchy_ref);
    expect(ref.label).toBe("1000 Wareneinsatz [GmbH A]");

    // Sanity: company_id in the returned record IS now the wrapped m2o object,
    // confirming the wrap loop did run on this field. (This is the condition
    // that, if it ran first, would have made extractCompanyLabel return null.)
    const wrappedCompany = payload.records[0].company_id;
    expect(wrappedCompany).toMatchObject({
      label: "GmbH A",
      model: "res.company",
    });
    expect(typeof wrappedCompany.ref).toBe("string");
  });

  it("encodes companyId/companyLabel into self-ref when record has company_id", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      { name: "display_name", type: "char", required: false, readonly: false },
      {
        name: "company_id",
        type: "many2one",
        relation: "res.company",
        required: true,
        readonly: false,
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [
        {
          id: 42,
          display_name: "1000 Wareneinsatz",
          company_id: [7, "GmbH A"],
        },
      ],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.account": ["read"] },
      },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;
    const result = await tool.execute("call-tag", {
      model: "account.account",
      filters: [],
      fields: ["display_name"],
    });
    const payload = JSON.parse(result.content[0].text);
    const decoded = decodeRef(payload.records[0]._pinchy_ref);
    expect(decoded.companyId).toBe(7);
    expect(decoded.companyLabel).toBe("GmbH A");
  });

  it("encodes no company tag when the record has no company_id field", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      { name: "display_name", type: "char", required: false, readonly: false },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [{ id: 14, display_name: "Austria" }],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: { ...agentConfig, permissions: { "res.country": ["read"] } },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;
    const result = await tool.execute("call-notag", {
      model: "res.country",
      filters: [],
      fields: ["display_name"],
    });
    const decoded = decodeRef(
      JSON.parse(result.content[0].text).records[0]._pinchy_ref,
    );
    expect(decoded.companyId).toBeUndefined();
    expect(decoded.companyLabel).toBeUndefined();
  });

  it("encodes no company tag when company_id is false (single-company tenant)", async () => {
    mockFields.mockResolvedValue([
      { name: "id", type: "integer", required: false, readonly: true },
      { name: "display_name", type: "char", required: false, readonly: false },
      {
        name: "company_id",
        type: "many2one",
        relation: "res.company",
        required: false,
        readonly: false,
      },
    ]);
    mockSearchRead.mockResolvedValue({
      records: [{ id: 99, display_name: "Generic", company_id: false }],
      total: 1,
      limit: 1,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.account": ["read"] },
      },
    });
    const tool = findTool(tools, "odoo_read", agentId)!;
    const result = await tool.execute("call-false", {
      model: "account.account",
      filters: [],
      fields: ["display_name"],
    });
    const decoded = decodeRef(
      JSON.parse(result.content[0].text).records[0]._pinchy_ref,
    );
    expect(decoded.companyId).toBeUndefined();
    expect(decoded.companyLabel).toBeUndefined();
  });
});

describe("m2o lookup multi-company error", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  it("explains multi-match as a multi-company collision and suggests company_id filter", async () => {
    // Fields for the parent model (account.move.line) so create can resolve
    mockFields.mockImplementation(async (model: string) => {
      if (model === "account.move.line") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          {
            name: "account_id",
            type: "many2one",
            relation: "account.account",
            required: true,
            readonly: false,
          },
        ];
      }
      if (model === "account.account") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          { name: "name", type: "char", required: false, readonly: false },
          {
            name: "display_name",
            type: "char",
            required: false,
            readonly: false,
          },
          {
            name: "company_id",
            type: "many2one",
            relation: "res.company",
            required: true,
            readonly: false,
          },
        ];
      }
      return [];
    });
    // Lookup finds two matches across companies
    mockSearchRead.mockResolvedValue({
      records: [
        {
          id: 42,
          name: "Wareneinsatz",
          display_name: "1000 Wareneinsatz",
          company_id: [1, "GmbH A"],
        },
        {
          id: 87,
          name: "Wareneinsatz",
          display_name: "1000 Wareneinsatz",
          company_id: [2, "GmbH B"],
        },
      ],
      total: 2,
      limit: 20,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.move.line": ["create"] },
      },
    });
    const tool = findTool(tools, "odoo_create", agentId)!;

    const result = await tool.execute("call-multi", {
      model: "account.move.line",
      values: { account_id: "1000 Wareneinsatz" },
    });

    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toMatch(/multiple/i);
    expect(text).toMatch(/GmbH A/);
    expect(text).toMatch(/GmbH B/);
    expect(text).toMatch(/company_id/);
  });

  it("still includes company_id in the relation searchRead so the breakdown is possible", async () => {
    mockFields.mockImplementation(async (model: string) => {
      if (model === "account.move.line") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          {
            name: "account_id",
            type: "many2one",
            relation: "account.account",
            required: true,
            readonly: false,
          },
        ];
      }
      if (model === "account.account") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          { name: "name", type: "char", required: false, readonly: false },
          {
            name: "display_name",
            type: "char",
            required: false,
            readonly: false,
          },
          {
            name: "company_id",
            type: "many2one",
            relation: "res.company",
            required: true,
            readonly: false,
          },
        ];
      }
      return [];
    });
    mockSearchRead.mockResolvedValue({
      records: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.move.line": ["create"] },
      },
    });
    const tool = findTool(tools, "odoo_create", agentId)!;
    await tool
      .execute("call-fields", {
        model: "account.move.line",
        values: { account_id: "Wareneinsatz" },
      })
      .catch(() => {});

    const lookupCall = mockSearchRead.mock.calls.find(
      ([model]) => model === "account.account",
    );
    expect(lookupCall).toBeDefined();
    expect(lookupCall![2]?.fields).toEqual(
      expect.arrayContaining(["id", "name", "display_name", "company_id"]),
    );
  });

  it("does NOT request company_id from relations that lack it (e.g. res.currency)", async () => {
    mockFields.mockImplementation(async (model: string) => {
      if (model === "account.move") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          {
            name: "currency_id",
            type: "many2one",
            relation: "res.currency",
            required: true,
            readonly: false,
          },
        ];
      }
      if (model === "res.currency") {
        // No company_id on res.currency — would make Odoo throw if we requested it
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          { name: "name", type: "char", required: false, readonly: false },
          {
            name: "display_name",
            type: "char",
            required: false,
            readonly: false,
          },
        ];
      }
      return [];
    });
    mockSearchRead.mockResolvedValue({
      records: [],
      total: 0,
      limit: 20,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.move": ["create"] },
      },
    });
    const tool = findTool(tools, "odoo_create", agentId)!;
    await tool
      .execute("call-no-cid", {
        model: "account.move",
        values: { currency_id: "USD" },
      })
      .catch(() => {});

    const currencyLookup = mockSearchRead.mock.calls.find(
      ([model]) => model === "res.currency",
    );
    expect(currencyLookup).toBeDefined();
    expect(currencyLookup![2]?.fields).not.toContain("company_id");
  });

  it("falls back to the plain multi-match error when all matches are in the same company", async () => {
    // Edge case: two records, same company → should NOT mention "multi-company collision"
    // (the original generic message is appropriate)
    mockFields.mockImplementation(async (model: string) => {
      if (model === "account.move.line") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          {
            name: "account_id",
            type: "many2one",
            relation: "account.account",
            required: true,
            readonly: false,
          },
        ];
      }
      return [];
    });
    mockSearchRead.mockResolvedValue({
      records: [
        { id: 1, name: "Foo", display_name: "Foo", company_id: [1, "GmbH A"] },
        { id: 2, name: "Foo", display_name: "Foo", company_id: [1, "GmbH A"] },
      ],
      total: 2,
      limit: 20,
      offset: 0,
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.move.line": ["create"] },
      },
    });
    const tool = findTool(tools, "odoo_create", agentId)!;
    const result = await tool.execute("call-same", {
      model: "account.move.line",
      values: { account_id: "Foo" },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/multiple/i);
    expect(result.content[0].text).not.toMatch(/multi-company collision/);
  });
});

describe("cross-company write guard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  it("rejects when a values.company_id ref disagrees with another m2o ref's companyId", async () => {
    const companyRefA = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.company",
      id: 1,
      label: "GmbH A",
      companyId: 1,
      companyLabel: "GmbH A",
    });
    const accountRefBInCompanyB = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.account",
      id: 87,
      label: "1000 Wareneinsatz [GmbH B]",
      companyId: 2,
      companyLabel: "GmbH B",
    });

    mockFields.mockImplementation(async (model: string) => {
      if (model === "account.move.line") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          {
            name: "company_id",
            type: "many2one",
            relation: "res.company",
            required: false,
            readonly: false,
          },
          {
            name: "account_id",
            type: "many2one",
            relation: "account.account",
            required: true,
            readonly: false,
          },
        ];
      }
      return [];
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.move.line": ["create"] },
      },
    });
    const tool = findTool(tools, "odoo_create", agentId)!;
    const result = await tool.execute("call-xc", {
      model: "account.move.line",
      values: {
        company_id: { ref: companyRefA },
        account_id: { ref: accountRefBInCompanyB },
      },
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cross-company/i);
    expect(result.content[0].text).toMatch(/GmbH A/);
    expect(result.content[0].text).toMatch(/GmbH B/);
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("allows the write when all refs agree on the company", async () => {
    const refCompanyA = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.company",
      id: 1,
      label: "GmbH A",
      companyId: 1,
      companyLabel: "GmbH A",
    });
    const refAccountA = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.account",
      id: 42,
      label: "1000 Wareneinsatz [GmbH A]",
      companyId: 1,
      companyLabel: "GmbH A",
    });

    mockFields.mockImplementation(async (model: string) => {
      if (model === "account.move.line") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          {
            name: "company_id",
            type: "many2one",
            relation: "res.company",
            required: false,
            readonly: false,
          },
          {
            name: "account_id",
            type: "many2one",
            relation: "account.account",
            required: true,
            readonly: false,
          },
        ];
      }
      return [];
    });
    mockCreate.mockResolvedValue(99);

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.move.line": ["create"] },
      },
    });
    const tool = findTool(tools, "odoo_create", agentId)!;
    const result = await tool.execute("call-ok", {
      model: "account.move.line",
      values: {
        company_id: { ref: refCompanyA },
        account_id: { ref: refAccountA },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalled();
  });

  it("allows legacy refs (no companyId tag) to pass through without the guard tripping", async () => {
    const legacyRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.account",
      id: 42,
      label: "1000 Wareneinsatz",
    });
    const companyRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.company",
      id: 1,
      label: "GmbH A",
      companyId: 1,
      companyLabel: "GmbH A",
    });

    mockFields.mockImplementation(async (model: string) => {
      if (model === "account.move.line") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          {
            name: "company_id",
            type: "many2one",
            relation: "res.company",
            required: false,
            readonly: false,
          },
          {
            name: "account_id",
            type: "many2one",
            relation: "account.account",
            required: true,
            readonly: false,
          },
        ];
      }
      return [];
    });
    mockCreate.mockResolvedValue(100);

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.move.line": ["create"] },
      },
    });
    const tool = findTool(tools, "odoo_create", agentId)!;
    const result = await tool.execute("call-legacy", {
      model: "account.move.line",
      values: {
        company_id: { ref: companyRef },
        account_id: { ref: legacyRef },
      },
    });
    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalled();
  });

  it("does not trip when values has no company_id ref (e.g. write to a company-implicit model)", async () => {
    const refTagged = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.account",
      id: 42,
      label: "x",
      companyId: 1,
      companyLabel: "GmbH A",
    });
    mockFields.mockImplementation(async () => [
      { name: "id", type: "integer", required: false, readonly: true },
      {
        name: "account_id",
        type: "many2one",
        relation: "account.account",
        required: true,
        readonly: false,
      },
    ]);
    mockCreate.mockResolvedValue(101);

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.move.line": ["create"] },
      },
    });
    const tool = findTool(tools, "odoo_create", agentId)!;
    const result = await tool.execute("call-no-cid", {
      model: "account.move.line",
      values: { account_id: { ref: refTagged } },
    });
    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalled();
  });

  it("also fires on odoo_write (not only odoo_create)", async () => {
    const companyRefA = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "res.company",
      id: 1,
      label: "GmbH A",
      companyId: 1,
      companyLabel: "GmbH A",
    });
    const accountRefB = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "account.account",
      id: 87,
      label: "x",
      companyId: 2,
      companyLabel: "GmbH B",
    });

    mockFields.mockImplementation(async (model: string) => {
      if (model === "account.move.line") {
        return [
          { name: "id", type: "integer", required: false, readonly: true },
          {
            name: "company_id",
            type: "many2one",
            relation: "res.company",
            required: false,
            readonly: false,
          },
          {
            name: "account_id",
            type: "many2one",
            relation: "account.account",
            required: true,
            readonly: false,
          },
        ];
      }
      return [];
    });

    const tools = createApi({
      [agentId]: {
        ...agentConfig,
        permissions: { "account.move.line": ["write"] },
      },
    });
    const tool = findTool(tools, "odoo_write", agentId)!;
    const result = await tool.execute("call-xc-write", {
      model: "account.move.line",
      ids: [99],
      values: {
        company_id: { ref: companyRefA },
        account_id: { ref: accountRefB },
      },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/cross-company/i);
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe("odoo_schedule_activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  const activityConfig = {
    connectionId: "conn-test-1",
    permissions: {
      "crm.lead": ["read", "create", "write"],
      "mail.activity": ["read", "create", "write"],
    },
  };

  function leadRef(connectionId = "conn-test-1"): string {
    return encodeRef({
      integrationType: "odoo",
      connectionId,
      model: "crm.lead",
      id: 1,
      label: "Big Fence Order",
    });
  }

  it("is registered as a tool", () => {
    const tools = createApi({ [agentId]: activityConfig });
    expect(tools.map((t) => t.name)).toContain("odoo_schedule_activity");
  });

  it("builds the mail.activity payload with resolved res_model_id, default To-Do type, and the lead's salesperson", async () => {
    mockSearchRead.mockImplementation(async (model: string) => {
      if (model === "ir.model")
        return { records: [{ id: 5 }], total: 1, limit: 1, offset: 0 };
      if (model === "ir.model.data")
        return {
          records: [{ id: 1, res_id: 9 }],
          total: 1,
          limit: 1,
          offset: 0,
        };
      if (model === "crm.lead")
        return {
          records: [{ id: 1, user_id: [7, "Sally Seller"] }],
          total: 1,
          limit: 1,
          offset: 0,
        };
      return { records: [], total: 0, limit: 0, offset: 0 };
    });
    mockCreate.mockResolvedValue(42);

    const tools = createApi({ [agentId]: activityConfig });
    const tool = findTool(tools, "odoo_schedule_activity", agentId)!;
    const result = await tool.execute("c", {
      target: leadRef(),
      summary: "Call about the quote",
      dueDate: "2026-06-30",
    });

    expect(result.isError).toBeFalsy();
    expect(mockCreate).toHaveBeenCalledWith("mail.activity", {
      res_model_id: 5,
      res_id: 1,
      date_deadline: "2026-06-30",
      summary: "Call about the quote",
      activity_type_id: 9,
      user_id: 7,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe(42);
    expect(data._pinchy_ref).toMatch(/^pinchy_ref:v1:/);
  });

  it("falls back to Odoo's default activity type when the To-Do xmlid is absent", async () => {
    mockSearchRead.mockImplementation(async (model: string) => {
      if (model === "ir.model")
        return { records: [{ id: 5 }], total: 1, limit: 1, offset: 0 };
      // ir.model.data lookup finds nothing → no activity_type_id forced
      return { records: [], total: 0, limit: 0, offset: 0 };
    });
    mockCreate.mockResolvedValue(1);

    const tools = createApi({ [agentId]: activityConfig });
    const tool = findTool(tools, "odoo_schedule_activity", agentId)!;
    await tool.execute("c", {
      target: leadRef(),
      summary: "Follow up",
      dueDate: "2026-06-30",
    });

    const [, values] = mockCreate.mock.calls[0];
    expect(values).not.toHaveProperty("activity_type_id");
    expect(values).not.toHaveProperty("user_id");
  });

  it("denies the call when the agent lacks create on mail.activity", async () => {
    const tools = createApi({
      [agentId]: {
        connectionId: "conn-test-1",
        permissions: { "crm.lead": ["read"] },
      },
    });
    const tool = findTool(tools, "odoo_schedule_activity", agentId)!;
    const result = await tool.execute("c", {
      target: leadRef(),
      summary: "x",
      dueDate: "2026-06-30",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a malformed dueDate before touching Odoo", async () => {
    const tools = createApi({ [agentId]: activityConfig });
    const tool = findTool(tools, "odoo_schedule_activity", agentId)!;
    const result = await tool.execute("c", {
      target: leadRef(),
      summary: "x",
      dueDate: "next friday",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("YYYY-MM-DD");
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it("rejects a target ref from a different connection", async () => {
    const tools = createApi({ [agentId]: activityConfig });
    const tool = findTool(tools, "odoo_schedule_activity", agentId)!;
    const result = await tool.execute("c", {
      target: leadRef("conn-OTHER"),
      summary: "x",
      dueDate: "2026-06-30",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(
      "does not belong to this Odoo connection",
    );
    expect(mockCreate).not.toHaveBeenCalled();
  });
});

describe("odoo_complete_activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  const cfg = {
    connectionId: "conn-test-1",
    permissions: { "mail.activity": ["read", "create", "write"] },
  };
  const activityRef = (connectionId = "conn-test-1"): string =>
    encodeRef({
      integrationType: "odoo",
      connectionId,
      model: "mail.activity",
      id: 5,
      label: "Call about the quote",
    });

  it("is registered as a tool", () => {
    const tools = createApi({ [agentId]: cfg });
    expect(tools.map((t) => t.name)).toContain("odoo_complete_activity");
  });

  it("calls action_feedback on the activity with the feedback note", async () => {
    mockCallMethod.mockResolvedValue(true);
    const tools = createApi({ [agentId]: cfg });
    const tool = findTool(tools, "odoo_complete_activity", agentId)!;
    const result = await tool.execute("c", {
      target: activityRef(),
      feedback: "Spoke to the customer",
    });
    expect(result.isError).toBeFalsy();
    expect(mockCallMethod).toHaveBeenCalledWith(
      "mail.activity",
      "action_feedback",
      [[5]],
      { feedback: "Spoke to the customer" },
    );
  });

  it("omits the feedback kwarg when none is given", async () => {
    mockCallMethod.mockResolvedValue(true);
    const tools = createApi({ [agentId]: cfg });
    const tool = findTool(tools, "odoo_complete_activity", agentId)!;
    await tool.execute("c", { target: activityRef() });
    expect(mockCallMethod).toHaveBeenCalledWith(
      "mail.activity",
      "action_feedback",
      [[5]],
      {},
    );
  });

  it("requires write on mail.activity", async () => {
    const tools = createApi({
      [agentId]: {
        connectionId: "conn-test-1",
        permissions: { "mail.activity": ["read"] },
      },
    });
    const tool = findTool(tools, "odoo_complete_activity", agentId)!;
    const result = await tool.execute("c", { target: activityRef() });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("rejects a target that is not a mail.activity record", async () => {
    const leadRef = encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "crm.lead",
      id: 1,
      label: "x",
    });
    const tools = createApi({ [agentId]: cfg });
    const tool = findTool(tools, "odoo_complete_activity", agentId)!;
    const result = await tool.execute("c", { target: leadRef });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/mail\.activity/);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });
});

describe("odoo_reschedule_activity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  const cfg = {
    connectionId: "conn-test-1",
    permissions: { "mail.activity": ["read", "create", "write"] },
  };
  const activityRef = (): string =>
    encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model: "mail.activity",
      id: 5,
      label: "Call about the quote",
    });

  it("is registered as a tool", () => {
    const tools = createApi({ [agentId]: cfg });
    expect(tools.map((t) => t.name)).toContain("odoo_reschedule_activity");
  });

  it("writes the new deadline and resolves the new assignee", async () => {
    mockSearchRead.mockImplementation(async (model: string) =>
      model === "res.users"
        ? { records: [{ id: 2 }], total: 1, limit: 2, offset: 0 }
        : { records: [], total: 0, limit: 0, offset: 0 },
    );
    mockWrite.mockResolvedValue(true);

    const tools = createApi({ [agentId]: cfg });
    const tool = findTool(tools, "odoo_reschedule_activity", agentId)!;
    const result = await tool.execute("c", {
      target: activityRef(),
      dueDate: "2026-08-01",
      assignee: "Mitch Admin",
    });

    expect(result.isError).toBeFalsy();
    expect(mockWrite).toHaveBeenCalledWith("mail.activity", [5], {
      date_deadline: "2026-08-01",
      user_id: 2,
    });
  });

  it("writes only the deadline when no assignee is given", async () => {
    mockWrite.mockResolvedValue(true);
    const tools = createApi({ [agentId]: cfg });
    const tool = findTool(tools, "odoo_reschedule_activity", agentId)!;
    await tool.execute("c", { target: activityRef(), dueDate: "2026-08-01" });
    expect(mockWrite).toHaveBeenCalledWith("mail.activity", [5], {
      date_deadline: "2026-08-01",
    });
  });

  it("errors when neither dueDate nor assignee is provided", async () => {
    const tools = createApi({ [agentId]: cfg });
    const tool = findTool(tools, "odoo_reschedule_activity", agentId)!;
    const result = await tool.execute("c", { target: activityRef() });
    expect(result.isError).toBe(true);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("requires write on mail.activity", async () => {
    const tools = createApi({
      [agentId]: {
        connectionId: "conn-test-1",
        permissions: { "mail.activity": ["read"] },
      },
    });
    const tool = findTool(tools, "odoo_reschedule_activity", agentId)!;
    const result = await tool.execute("c", {
      target: activityRef(),
      dueDate: "2026-08-01",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockWrite).not.toHaveBeenCalled();
  });
});

describe("odoo record-action tools (confirm / apply / validate / mark-done)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  const RECORD_ACTIONS = [
    {
      tool: "odoo_confirm_order",
      model: "sale.order",
      method: "action_confirm",
    },
    {
      tool: "odoo_apply_inventory",
      model: "stock.quant",
      method: "action_apply_inventory",
    },
    {
      tool: "odoo_validate_picking",
      model: "stock.picking",
      method: "button_validate",
    },
    {
      tool: "odoo_mark_mo_done",
      model: "mrp.production",
      method: "button_mark_done",
    },
  ] as const;

  function ref(model: string): string {
    return encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model,
      id: 7,
      label: "x",
    });
  }

  for (const { tool, model, method } of RECORD_ACTIONS) {
    describe(tool, () => {
      const cfg = {
        connectionId: "conn-test-1",
        permissions: { [model]: ["read", "write"] },
      };

      it("is registered", () => {
        expect(createApi({ [agentId]: cfg }).map((t) => t.name)).toContain(
          tool,
        );
      });

      it(`calls ${method} and reports completed`, async () => {
        mockCallMethod.mockResolvedValue(true);
        const t = findTool(createApi({ [agentId]: cfg }), tool, agentId)!;
        const result = await t.execute("c", { target: ref(model) });
        expect(result.isError).toBeFalsy();
        expect(mockCallMethod).toHaveBeenCalledWith(model, method, [[7]], {});
        expect(JSON.parse(result.content[0].text).completed).toBe(true);
      });

      it("hands off (does not claim success) on a wizard action", async () => {
        mockCallMethod.mockResolvedValue({
          type: "ir.actions.act_window",
          res_model: "stock.backorder.confirmation",
        });
        const t = findTool(createApi({ [agentId]: cfg }), tool, agentId)!;
        const result = await t.execute("c", { target: ref(model) });
        expect(result.isError).toBeFalsy();
        const data = JSON.parse(result.content[0].text);
        expect(data.completed).toBe(false);
        expect(data.needsHuman).toBe(true);
        expect(data.pendingStep).toBe("stock.backorder.confirmation");
      });

      it("requires write permission", async () => {
        const t = findTool(
          createApi({
            [agentId]: {
              connectionId: "conn-test-1",
              permissions: { [model]: ["read"] },
            },
          }),
          tool,
          agentId,
        )!;
        const result = await t.execute("c", { target: ref(model) });
        expect(result.isError).toBe(true);
        expect(result.content[0].text).toContain("Permission denied");
        expect(mockCallMethod).not.toHaveBeenCalled();
      });

      it("rejects a ref for the wrong model", async () => {
        const t = findTool(createApi({ [agentId]: cfg }), tool, agentId)!;
        const result = await t.execute("c", { target: ref("res.partner") });
        expect(result.isError).toBe(true);
        expect(mockCallMethod).not.toHaveBeenCalled();
      });
    });
  }
});

describe("odoo_set_approval", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubEnv("PINCHY_REF_TOKEN_KEY", "a".repeat(64));
  });

  function ref(model: string): string {
    return encodeRef({
      integrationType: "odoo",
      connectionId: "conn-test-1",
      model,
      id: 3,
      label: "x",
    });
  }

  it("approves a purchase order via button_confirm", async () => {
    mockCallMethod.mockResolvedValue(true);
    const t = findTool(
      createApi({
        [agentId]: {
          connectionId: "conn-test-1",
          permissions: { "purchase.order": ["read", "write"] },
        },
      }),
      "odoo_set_approval",
      agentId,
    )!;
    const result = await t.execute("c", {
      target: ref("purchase.order"),
      decision: "approve",
    });
    expect(result.isError).toBeFalsy();
    expect(mockCallMethod).toHaveBeenCalledWith(
      "purchase.order",
      "button_confirm",
      [[3]],
      {},
    );
  });

  it("refuses an expense sheet via refuse_sheet with the reason as a positional arg", async () => {
    mockCallMethod.mockResolvedValue(true);
    const t = findTool(
      createApi({
        [agentId]: {
          connectionId: "conn-test-1",
          permissions: { "hr.expense.sheet": ["read", "write"] },
        },
      }),
      "odoo_set_approval",
      agentId,
    )!;
    const result = await t.execute("c", {
      target: ref("hr.expense.sheet"),
      decision: "refuse",
      reason: "Over budget",
    });
    expect(result.isError).toBeFalsy();
    expect(mockCallMethod).toHaveBeenCalledWith(
      "hr.expense.sheet",
      "refuse_sheet",
      [[3], "Over budget"],
      {},
    );
  });

  it("rejects an unsupported model", async () => {
    const t = findTool(
      createApi({
        [agentId]: {
          connectionId: "conn-test-1",
          permissions: { "sale.order": ["read", "write"] },
        },
      }),
      "odoo_set_approval",
      agentId,
    )!;
    const result = await t.execute("c", {
      target: ref("sale.order"),
      decision: "approve",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/not an approvable model/);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("rejects an invalid decision", async () => {
    const t = findTool(
      createApi({
        [agentId]: {
          connectionId: "conn-test-1",
          permissions: { "purchase.order": ["read", "write"] },
        },
      }),
      "odoo_set_approval",
      agentId,
    )!;
    const result = await t.execute("c", {
      target: ref("purchase.order"),
      decision: "maybe",
    });
    expect(result.isError).toBe(true);
    expect(mockCallMethod).not.toHaveBeenCalled();
  });

  it("requires write permission on the target model", async () => {
    const t = findTool(
      createApi({
        [agentId]: {
          connectionId: "conn-test-1",
          permissions: { "purchase.order": ["read"] },
        },
      }),
      "odoo_set_approval",
      agentId,
    )!;
    const result = await t.execute("c", {
      target: ref("purchase.order"),
      decision: "approve",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("Permission denied");
    expect(mockCallMethod).not.toHaveBeenCalled();
  });
});
