import { describe, it, expect } from "vitest";
import { summarizeArgs } from "./summary";

describe("summarizeArgs", () => {
  it("keeps short, non-secret scalar values (informed confirmation)", () => {
    expect(summarizeArgs({ to: "x@example.com", subject: "Invoice" })).toEqual({
      to: "x@example.com",
      subject: "Invoice",
    });
  });

  it("redacts secret-looking keys", () => {
    const out = summarizeArgs({ apiKey: "sk-123", password: "p", auth_token: "t", to: "x@y.z" });
    expect(out.apiKey).toBe("[redacted]");
    expect(out.password).toBe("[redacted]");
    expect(out.auth_token).toBe("[redacted]");
    expect(out.to).toBe("x@y.z");
  });

  it("keeps a long string whole up to the stored limit, so the card can offer the full text", () => {
    const body = "a".repeat(500);
    expect(summarizeArgs({ body })).toEqual({ body });
  });

  it("marks a string that exceeds the stored limit as truncated, and says by how much", () => {
    const out = summarizeArgs({ body: "a".repeat(10_000) }) as { body: string };
    expect(out.body).toMatch(/\[truncated: \d+ more characters not shown\]$/);
    expect(out.body.length).toBeLessThan(5_000);
  });

  it("shows the contents of arrays and objects, not a shape hint", () => {
    expect(summarizeArgs({ items: [1, 2, 3], meta: { a: 1, b: "two" } })).toEqual({
      items: [1, 2, 3],
      meta: { a: 1, b: "two" },
    });
  });

  it("returns {} for non-object params", () => {
    expect(summarizeArgs(null)).toEqual({});
    expect(summarizeArgs("nope")).toEqual({});
    expect(summarizeArgs([1, 2])).toEqual({});
  });

  it("redacts secret-looking keys at any depth", () => {
    const out = summarizeArgs({
      values: { note: "x", api_key: "sk-1", nested: [{ password: "hunter2" }] },
    });
    expect(JSON.stringify(out)).not.toContain("sk-1");
    expect(JSON.stringify(out)).not.toContain("hunter2");
    expect(JSON.stringify(out)).toContain("[redacted]");
  });

  describe("what the approver sees is what runs", () => {
    it("does not let a run of spaces push a second recipient out of view", () => {
      const out = summarizeArgs({
        to: `chef@firma.at${" ".repeat(300)}, angreifer@evil.com`,
      });
      expect(out.to).toEqual(["chef@firma.at", "angreifer@evil.com"]);
    });

    it("lists every address of to, cc and bcc explicitly, one per entry", () => {
      const out = summarizeArgs({
        to: "a@x.at; b@x.at",
        cc: ["c@x.at", "d@x.at, e@x.at"],
        bcc: "Evil <f@evil.com>",
      });
      expect(out.to).toEqual(["a@x.at", "b@x.at"]);
      expect(out.cc).toEqual(["c@x.at", "d@x.at", "e@x.at"]);
      expect(out.bcc).toBe("Evil <f@evil.com>");
    });

    it("does not split on a comma inside a quoted display name", () => {
      const out = summarizeArgs({ to: '"Meier, Hans" <hans@x.at>, b@x.at' });
      expect(out.to).toEqual(['"Meier, Hans" <hans@x.at>', "b@x.at"]);
    });

    it("keeps a single recipient as a plain string", () => {
      expect(summarizeArgs({ to: "ada@example.com" }).to).toBe("ada@example.com");
    });

    it("collapses whitespace runs, tabs and newlines in displayed strings", () => {
      const out = summarizeArgs({ subject: "Hello   \n\t world\u00A0\u2003!" });
      expect(out.subject).toBe("Hello world !");
    });

    it("makes bidi and zero-width characters visible instead of letting them reorder text", () => {
      const out = summarizeArgs({ subject: "invoice\u202Egnp.exe\u200B" }) as {
        subject: string;
      };
      expect(out.subject).not.toContain("\u202E");
      expect(out.subject).not.toContain("\u200B");
      expect(out.subject).toContain("U+202E");
    });

    it("shows every id and value of an odoo_write, not '[1 item]' and '{2 fields}'", () => {
      const params = {
        model: "res.partner.bank",
        ids: [42],
        values: { acc_number: "AT61 1904 3002 3457 3201", amount: 99999 },
      };
      expect(summarizeArgs(params)).toEqual(params);
    });

    it("shows what the nested line commands of an odoo_create say", () => {
      const out = summarizeArgs({
        values: { line_ids: [[0, 0, { name: "Consulting", price_unit: 1 }]] },
      });
      expect(JSON.stringify(out)).toContain("Consulting");
      expect(JSON.stringify(out)).toContain("price_unit");
    });

    it("says so when keys, items or depth are cut, never silently drops them", () => {
      const manyKeys = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`k${i}`, i]));
      expect(JSON.stringify(summarizeArgs(manyKeys))).toMatch(/more fields? not shown/);
      const manyItems = Array.from({ length: 200 }, (_, i) => i);
      expect(JSON.stringify(summarizeArgs({ ids: manyItems }))).toMatch(/more items? not shown/);
      let deep: unknown = "bottom";
      for (let i = 0; i < 20; i++) deep = { n: deep };
      expect(JSON.stringify(summarizeArgs({ deep }))).toMatch(/not shown/);
    });

    it("bounds the total size, and says that it did", () => {
      const huge = Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`k${i}`, "z".repeat(3_900)])
      );
      const json = JSON.stringify(summarizeArgs(huge));
      expect(json.length).toBeLessThan(40_000);
      expect(json).toMatch(/not shown/);
    });

    it("does not treat a __proto__ key as a prototype assignment", () => {
      const params = JSON.parse('{"__proto__": {"to": "x@evil.com"}, "ok": 1}');
      const out = summarizeArgs(params);
      expect(Object.keys(out)).toContain("__proto__");
      expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    });
  });

  describe("opaque record references", () => {
    it("keeps '(record reference)' when the model cannot be resolved", () => {
      expect(summarizeArgs({ target: "pinchy_ref:v1:AAAA" }).target).toBe("(record reference)");
    });

    it("names the resolved model when it can", () => {
      const out = summarizeArgs(
        { target: "pinchy_ref:v1:AAAA", more: ["pinchy_ref:v1:BBBB"] },
        { refModel: (ref) => (ref.endsWith("AAAA") ? "account.move" : "account.payment") }
      );
      expect(out.target).toBe("(record reference: account.move)");
      expect(out.more).toEqual(["(record reference: account.payment)"]);
    });
  });
});
