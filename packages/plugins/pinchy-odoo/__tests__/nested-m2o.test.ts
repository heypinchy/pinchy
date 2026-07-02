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
  const client = {
    async fields(model: string) {
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
  return { client: client as unknown as OdooClient, calls };
}

describe("normalizeMany2OneValues — nested one2many command tuples (#615)", () => {
  it("resolves m2o fields inside create command tuples with the parent's company scope", async () => {
    const { client, calls } = makeMockClient();
    const values = {
      company_id: "GmbH A",
      line_ids: [[0, 0, { account_id: "Main Bank", debit: 100 }]],
    };

    const result = await normalizeMany2OneValues(
      client,
      "conn-1",
      "account.move",
      values,
    );

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

    const result = await normalizeMany2OneValues(
      client,
      "conn-1",
      "account.move",
      values,
    );
    expect(result.line_ids).toEqual([[4, 42], [5], [6, 0, [1, 2, 3]], [2, 9]]);
  });

  it("resolves m2o fields inside update command tuples ([1, id, {values}])", async () => {
    const { client } = makeMockClient();
    const values = {
      line_ids: [[1, 77, { account_id: "Main Bank", credit: 50 }]],
    };

    const result = await normalizeMany2OneValues(
      client,
      "conn-1",
      "account.move",
      values,
    );
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

    const result = (await normalizeMany2OneValues(
      client,
      "conn-1",
      "account.move",
      values,
    )) as { line_ids: unknown[] };

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
});
