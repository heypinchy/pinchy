// @vitest-environment node
import { describe, it, expect, vi } from "vitest";
import { normalizeMany2OneValues } from "../index";

// Mock odoo-node so importing the plugin doesn't pull the real client.
vi.mock("odoo-node", () => ({ OdooClient: vi.fn() }));

import type { OdooClient } from "odoo-node";

const FIELDS: Record<string, Record<string, unknown>> = {
  "account.move": {
    company_id: {
      type: "many2one",
      relation: "res.company",
      string: "Company",
    },
    journal_id: {
      type: "many2one",
      relation: "account.journal",
      string: "Journal",
    },
    line_ids: {
      type: "one2many",
      relation: "account.move.line",
      string: "Lines",
    },
  },
  "account.move.line": {
    company_id: { type: "many2one", relation: "res.company" },
    account_id: {
      type: "many2one",
      relation: "account.account",
      string: "Account",
    },
    debit: { type: "float" },
    credit: { type: "float" },
  },
  "res.company": { name: { type: "char" } },
  "account.account": {
    name: { type: "char" },
    company_id: { type: "many2one", relation: "res.company" },
  },
  "account.journal": {
    name: { type: "char" },
    company_id: { type: "many2one", relation: "res.company" },
  },
};

function makeMockClient() {
  const calls: { relation: string; domain: unknown }[] = [];
  const fieldsCalls: string[] = [];
  const client = {
    async fields(model: string) {
      fieldsCalls.push(model);
      return FIELDS[model] ?? {};
    },
    async searchRead(relation: string, domain: unknown) {
      calls.push({ relation, domain });
      if (relation === "res.company") {
        return [{ id: 1, name: "GmbH A", display_name: "GmbH A" }];
      }
      if (relation === "account.account") {
        return [
          {
            id: 5,
            name: "Main Bank",
            display_name: "Main Bank",
            company_id: [1, "GmbH A"],
          },
        ];
      }
      return [];
    },
  };
  return { client: client as unknown as OdooClient, calls, fieldsCalls };
}

// Permissions with account.move.line grants for every op the nested walker
// checks — used by tests in this file that aren't specifically exercising
// permission gating (Feature 1 below), so they keep passing as before.
const FULL_LINE_PERMISSIONS = {
  "account.move.line": ["create", "write", "delete"],
};

describe("normalizeMany2OneValues — nested one2many command tuples (#615)", () => {
  it("resolves m2o fields inside create command tuples with the parent's company scope", async () => {
    const { client, calls } = makeMockClient();
    const values = {
      company_id: "GmbH A",
      line_ids: [[0, 0, { account_id: "Main Bank", debit: 100 }]],
    };

    const result = (
      await normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        FULL_LINE_PERMISSIONS,
      )
    ).values;

    // company_id resolved to the res.company id.
    expect(result.company_id).toBe(1);
    // The nested account_id was resolved (not passed through as "Main Bank").
    expect(result.line_ids).toEqual([[0, 0, { account_id: 5, debit: 100 }]]);

    // The account.account lookup was company-scoped to the parent's company (1).
    const accountLookup = calls.find((c) => c.relation === "account.account");
    expect(accountLookup).toBeDefined();
    expect(JSON.stringify(accountLookup!.domain)).toContain('"company_id"');
    expect(JSON.stringify(accountLookup!.domain)).toContain("1");
  });

  it("passes non-create/update commands through unchanged", async () => {
    const { client } = makeMockClient();
    const values = {
      line_ids: [
        [4, 42], // link existing
        [5], // clear all
        [6, 0, [1, 2, 3]], // set to ids
        [2, 9], // delete
      ],
    };

    const result = (
      await normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        FULL_LINE_PERMISSIONS,
      )
    ).values;
    expect(result.line_ids).toEqual([[4, 42], [5], [6, 0, [1, 2, 3]], [2, 9]]);
  });

  it("resolves m2o fields inside update command tuples ([1, id, {values}])", async () => {
    const { client } = makeMockClient();
    const values = {
      line_ids: [[1, 77, { account_id: "Main Bank", credit: 50 }]],
    };

    const result = (
      await normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        FULL_LINE_PERMISSIONS,
      )
    ).values;
    expect(result.line_ids).toEqual([[1, 77, { account_id: 5, credit: 50 }]]);
  });

  it("does not recurse beyond one nesting level", async () => {
    // A one2many inside a line (depth 1) is left untouched — its m2o values
    // pass through verbatim. Bounds recursion through self-referential models.
    const { client, calls } = makeMockClient();
    FIELDS["account.move.line"].tax_ids = {
      type: "one2many",
      relation: "account.tax",
    };
    FIELDS["account.tax"] = { name: { type: "char" } };

    const values = {
      line_ids: [
        [0, 0, { account_id: "Main Bank", tax_ids: [[0, 0, { name: "VAT" }]] }],
      ],
    };

    const result = (
      await normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        FULL_LINE_PERMISSIONS,
      )
    ).values as { line_ids: unknown[] };

    // Top-level line's account_id resolved.
    const line = result.line_ids[0] as [
      number,
      number,
      Record<string, unknown>,
    ];
    expect(line[2].account_id).toBe(5);
    // The nested tax_ids tuple is left verbatim (name NOT resolved/looked up).
    expect(line[2].tax_ids).toEqual([[0, 0, { name: "VAT" }]]);
    // No account.tax lookup happened.
    expect(calls.find((c) => c.relation === "account.tax")).toBeUndefined();

    delete FIELDS["account.move.line"].tax_ids;
    delete FIELDS["account.tax"];
  });

  it("fetches each model's field schema at most once per create, not once per line", async () => {
    // A multi-line journal entry: three lines, all resolving account_id by
    // name against account.account. Without a request-scoped fields cache this
    // issued a fresh `fields_get` per line — account.move.line ×3 (one per
    // recursive normalizeMany2OneValues) plus account.account ×3 (one per
    // name lookup in searchRelationByName) — N redundant identical RPCs that
    // grow with the line count. The cache collapses each to a single fetch.
    const { client, fieldsCalls } = makeMockClient();
    const values = {
      company_id: "GmbH A",
      line_ids: [
        [0, 0, { account_id: "Main Bank", debit: 100 }],
        [0, 0, { account_id: "Main Bank", credit: 100 }],
        [0, 0, { account_id: "Main Bank", debit: 50 }],
      ],
    };

    await normalizeMany2OneValues(
      client,
      "conn-1",
      "account.move",
      values,
      FULL_LINE_PERMISSIONS,
    );

    const countOf = (model: string) =>
      fieldsCalls.filter((m) => m === model).length;
    // Parent schema: once. Line schema: once for all three lines. Account
    // lookup schema: once for all three name resolutions.
    expect(countOf("account.move")).toBe(1);
    expect(countOf("account.move.line")).toBe(1);
    expect(countOf("account.account")).toBe(1);
  });
});

// Hardening B: when the line model's schema comes back empty, the nested m2o
// resolution loop inside normalizeMany2OneValues has nothing to check ref
// shapes against and silently returns the values dict UNCHANGED — including
// any unresolved refs. A pure raw-id tuple ([6,0,[1,2,3]]) is harmless in
// that case (nothing needed resolving anyway), but a ref-shaped value inside
// a create/update tuple (e.g. a bare _pinchy_ref) reaching Odoo unresolved is
// a silent data-corruption risk. Fail loud instead.
describe("normalizeMany2OneValues — fail loud on empty line schema when resolution is needed (Hardening B)", () => {
  function makeEmptySchemaClient() {
    const client = {
      async fields(model: string) {
        if (model === "account.move") return FIELDS["account.move"];
        // account.move.line schema comes back EMPTY — simulates a broken
        // connection / stale cache / an Odoo model the plugin can't
        // introspect.
        return {};
      },
      async searchRead() {
        return [];
      },
    };
    return client as unknown as OdooClient;
  }

  it("throws naming the field and relation when a create tuple carries a bare _pinchy_ref and the line schema is empty", async () => {
    const client = makeEmptySchemaClient();
    const bareRef =
      "pinchy_ref:v1:doesnotneedtobevalid-the-schema-check-happens-first";
    const values = {
      line_ids: [[0, 0, { account_id: bareRef }]],
    };

    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        FULL_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(/line_ids/);
    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        FULL_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(/account\.move\.line/);
  });

  it("throws naming the field and relation when a create tuple carries a {ref} object and the line schema is empty", async () => {
    const client = makeEmptySchemaClient();
    const values = {
      line_ids: [[0, 0, { account_id: { ref: "pinchy_ref:v1:whatever" } }]],
    };

    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        FULL_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(/line_ids.*account\.move\.line/s);
  });

  it("passes a pure raw-id tuple ([6,0,[1,2]]) through unchanged when the line schema is empty (no resolution needed)", async () => {
    const client = makeEmptySchemaClient();
    const values = { line_ids: [[6, 0, [1, 2]]] };

    const result = await normalizeMany2OneValues(
      client,
      "conn-1",
      "account.move",
      values,
      FULL_LINE_PERMISSIONS,
    );
    expect(result.values.line_ids).toEqual([[6, 0, [1, 2]]]);
  });
});

describe("normalizeMany2OneValues — nested-permission gating (governance priority)", () => {
  // Codes that modify EXISTING nested one2many records require a grant on
  // the line model: 1 (update) needs write; 2 (delete)/3 (unlink)/5
  // (clear)/6 (replace) need delete — Odoo cascade-deletes orphaned lines
  // when a one2many with a required inverse is cleared or replaced (Odoo
  // "[FIX] fields: setting a one2many field deletes all its lines" #13082).
  // Inline create (0) needs no separate line grant: it's part of the
  // parent's atomic create, already gated by the top-level `create` check.
  const NO_LINE_PERMISSIONS = { "account.move": ["write"] };
  const WRITE_ONLY_LINE_PERMISSIONS = {
    "account.move": ["write"],
    "account.move.line": ["write"],
  };
  const DELETE_ONLY_LINE_PERMISSIONS = {
    "account.move": ["write"],
    "account.move.line": ["delete"],
  };

  it("rejects [2,id] delete without account.move.line:delete", async () => {
    const { client } = makeMockClient();
    const values = { line_ids: [[2, 1]] };
    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        NO_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(/delete/i);
  });

  it("rejects [3,id] unlink without account.move.line:delete", async () => {
    const { client } = makeMockClient();
    const values = { line_ids: [[3, 1]] };
    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        NO_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(/delete/i);
  });

  it("rejects [5] clear without account.move.line:delete", async () => {
    const { client } = makeMockClient();
    const values = { line_ids: [[5]] };
    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        NO_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(/delete/i);
  });

  it("rejects [6,0,[]] replace without account.move.line:delete", async () => {
    const { client } = makeMockClient();
    const values = { line_ids: [[6, 0, []]] };
    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        NO_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(/delete/i);
  });

  it("allows [2,id]/[3,id]/[5]/[6,0,[]] with account.move.line:delete granted", async () => {
    const { client } = makeMockClient();
    for (const cmd of [[2, 1], [3, 1], [5], [6, 0, []]]) {
      const values = { line_ids: [cmd] };
      const result = await normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        DELETE_ONLY_LINE_PERMISSIONS,
      );
      expect(result.values.line_ids).toEqual([cmd]);
    }
  });

  it("rejects [1,id,{...}] update without account.move.line:write", async () => {
    const { client } = makeMockClient();
    const values = {
      line_ids: [[1, 77, { account_id: "Main Bank", credit: 50 }]],
    };
    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        NO_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(/write/i);
  });

  it("allows [1,id,{...}] update with account.move.line:write granted", async () => {
    const { client } = makeMockClient();
    const values = {
      line_ids: [[1, 77, { account_id: "Main Bank", credit: 50 }]],
    };
    const result = await normalizeMany2OneValues(
      client,
      "conn-1",
      "account.move",
      values,
      WRITE_ONLY_LINE_PERMISSIONS,
    );
    expect(result.values.line_ids).toEqual([
      [1, 77, { account_id: 5, credit: 50 }],
    ]);
  });

  it("allows inline [0,0,{...}] create with only the parent's create grant (no line grant needed)", async () => {
    const { client } = makeMockClient();
    const values = {
      line_ids: [[0, 0, { account_id: "Main Bank", debit: 100 }]],
    };
    // Only account.move:create is granted — no account.move.line permission
    // at all — and inline create still succeeds.
    const result = await normalizeMany2OneValues(
      client,
      "conn-1",
      "account.move",
      values,
      { "account.move": ["create"] },
    );
    expect(result.values.line_ids).toEqual([
      [0, 0, { account_id: 5, debit: 100 }],
    ]);
  });

  it("allows [4,id] link without any account.move.line grant", async () => {
    const { client } = makeMockClient();
    const values = { line_ids: [[4, 42]] };
    const result = await normalizeMany2OneValues(
      client,
      "conn-1",
      "account.move",
      values,
      NO_LINE_PERMISSIONS,
    );
    expect(result.values.line_ids).toEqual([[4, 42]]);
  });

  it("error message names the missing operation, relation model, parent field, and command code", async () => {
    const { client } = makeMockClient();
    const values = { line_ids: [[2, 1]] };
    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        NO_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(
      /Agent missing delete grant on account\.move\.line.*line_ids.*command 2/,
    );
  });

  it("throws the PERMISSION error, not the empty-schema error, when both apply (authz wins)", async () => {
    // account.move schema present, account.move.line schema EMPTY, AND the
    // agent lacks account.move.line:delete. The permission gap must surface
    // (fail fast on authz before the schema round trip), not Hardening B's
    // empty-schema error. The target id is ref-shaped (not a raw number) so
    // `commandTuplesNeedResolution` is true and the empty-schema pre-check
    // actually has something to fire on — a plain numeric id wouldn't
    // exercise the race at all.
    const client = {
      async fields(model: string) {
        if (model === "account.move") return FIELDS["account.move"];
        return {}; // account.move.line schema comes back empty
      },
      async searchRead() {
        return [];
      },
    } as unknown as OdooClient;
    const values = {
      line_ids: [
        [2, "pinchy_ref:v1:doesnotneedtobevalid-the-schema-check-happens-first"],
      ],
    }; // delete needs account.move.line:delete
    await expect(
      normalizeMany2OneValues(
        client,
        "conn-1",
        "account.move",
        values,
        NO_LINE_PERMISSIONS,
      ),
    ).rejects.toThrow(/Agent missing delete grant on account\.move\.line/);
  });
});
