import { describe, it, expect, beforeAll } from "vitest";
import { domainToASCII } from "node:url";
import { summarizeArgs } from "./summary";
import { makeRefResolver } from "./call-models";
// The pinchy-odoo encoder, so the ref rendering is tested against real refs —
// see call-models.test.ts for why this crosses the package boundary.
import { encodeRef, _resetKeyCacheForTest } from "../../../../plugins/pinchy-odoo/integration-ref";

const REF_KEY = "b".repeat(64);
beforeAll(() => {
  process.env.PINCHY_REF_TOKEN_KEY = REF_KEY;
  _resetKeyCacheForTest();
});

describe("summarizeArgs", () => {
  it("keeps short, non-secret scalar values (informed confirmation)", () => {
    expect(summarizeArgs({ to: "x@example.com", subject: "Invoice" })).toEqual({
      to: "x@example.com",
      subject: "Invoice",
    });
  });

  // Corrected expectation (second review of #1242): a bare "[redacted]" hid
  // that a secret-like field is being SET at all — an attacker-chosen
  // access_token looked like any other redaction. The value stays hidden (it
  // may be a real secret), but the effect is now spelled out.
  it("hides secret-looking values but says that one is being set, and how long it is", () => {
    const out = summarizeArgs({ apiKey: "sk-123", password: "p", auth_token: "t", to: "x@y.z" });
    expect(out.apiKey).toBe("[secret-like field is being set — value hidden, 6 characters]");
    expect(out.password).toBe("[secret-like field is being set — value hidden, 1 character]");
    expect(out.auth_token).toBe("[secret-like field is being set — value hidden, 1 character]");
    expect(out.to).toBe("x@y.z");
  });

  it("makes an attacker-chosen token written into a record visible as a write", () => {
    const out = summarizeArgs({
      model: "res.users",
      ids: [2],
      values: { access_token: "attacker-known-0000", name: "Ada" },
    }) as { values: Record<string, unknown> };
    expect(out.values.access_token).toBe(
      "[secret-like field is being set — value hidden, 19 characters]"
    );
    expect(JSON.stringify(out)).not.toContain("attacker-known-0000");
  });

  it("names the kind of a hidden non-text secret value instead of its length", () => {
    const out = summarizeArgs({ credentials: { user: "a", pass: "b" }, api_key: null });
    expect(out.credentials).toBe("[secret-like field is being set — value hidden, an object]");
    expect(out.api_key).toBe("[secret-like field is being set — value hidden, null]");
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
    expect(JSON.stringify(out)).toContain("value hidden");
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
      // Address first, display name after (second review of #1242).
      expect(out.bcc).toBe('f@evil.com (name: "Evil")');
    });

    it("does not split on a comma inside a quoted display name", () => {
      const out = summarizeArgs({ to: '"Meier, Hans" <hans@x.at>, b@x.at' });
      expect(out.to).toEqual(['hans@x.at (name: "Meier, Hans")', "b@x.at"]);
    });

    it("keeps a single recipient as a plain string", () => {
      expect(summarizeArgs({ to: "ada@example.com" }).to).toBe("ada@example.com");
    });

    // Corrected expectation (second review of #1242): collapsing whitespace
    // rewrote the value, so the card no longer showed the string as sent. The
    // string is kept; plain spaces, tabs and line breaks stay (the card renders
    // them with pre-wrap), and every other space-like character is escaped.
    it("keeps whitespace as sent and escapes every space-like character that is not a space, tab or line break", () => {
      const out = summarizeArgs({ subject: "Hello   \n\t world\u00A0\u2003!" });
      expect(out.subject).toBe("Hello   \n\t world⟨U+00A0⟩⟨U+2003⟩!");
    });

    it("marks a run of four or more spaces, line breaks or tabs with its length", () => {
      const out = summarizeArgs({
        a: `x${" ".repeat(180)}y`,
        b: `x${"\n".repeat(40)}y`,
        c: `x${"\t".repeat(4)}y`,
        d: "x   y",
      });
      expect(out.a).toBe("x⟨180 spaces⟩y");
      expect(out.b).toBe("x⟨40 line breaks⟩y");
      expect(out.c).toBe("x⟨4 tabs⟩y");
      expect(out.d).toBe("x   y");
    });

    it.each([
      ["braille pattern blank", "\u2800"],
      ["hangul filler", "\u3164"],
      ["hangul choseong filler", "\u115F"],
      ["hangul jungseong filler", "\u1160"],
      ["halfwidth hangul filler", "\uFFA0"],
      ["ideographic space", "\u3000"],
      ["line separator", "\u2028"],
    ])("escapes the blank-rendering %s", (_name, char) => {
      const out = summarizeArgs({ subject: `x${char}y` }) as { subject: string };
      expect(out.subject).not.toContain(char);
      expect(out.subject).toMatch(/^x⟨U\+[0-9A-F]{4}⟩y$/);
    });

    // The probe of the second review: 180 braille blanks render as empty space,
    // so the path looked like a draft in reports/ while it resolved elsewhere.
    it("makes a path padded with blank-rendering characters readable", () => {
      const path = `/data/reports/old-draft.md${"\u2800".repeat(180)}/../../contracts/signed.pdf`;
      const out = summarizeArgs({ path }) as { path: string };
      expect(out.path).toBe(
        "/data/reports/old-draft.md⟨180 invisible characters: U+2800 U+2800 U+2800 …⟩/../../contracts/signed.pdf"
      );
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
    const ref = (model: string, id: number, label: string) =>
      encodeRef({ integrationType: "odoo", connectionId: "c1", model, id, label });

    // Corrected expectation (second review of #1242): replacing every string
    // that merely STARTS with the prefix hid free text — an email body that
    // began with "pinchy_ref:v1:" vanished behind "(record reference)". Only a
    // string that decodes to a record is rendered as one; anything else is
    // shown as the text it is.
    it("shows a string that does not decode as the text it is", () => {
      expect(summarizeArgs({ target: "pinchy_ref:v1:AAAA" }).target).toBe("pinchy_ref:v1:AAAA");
      expect(
        summarizeArgs({ target: "pinchy_ref:v1:AAAA" }, { refRecord: makeRefResolver(REF_KEY) })
          .target
      ).toBe("pinchy_ref:v1:AAAA");
    });

    it("never guesses from a ref it cannot decode, even with no key at all", () => {
      const token = ref("account.move", 42, "INV/2026/0042");
      const out = summarizeArgs({ target: token }, { refRecord: makeRefResolver(null) });
      expect(out.target).toBe(token);
      expect(out.target).not.toMatch(/account\.move|INV/);
    });

    it("does not hide free text that merely starts with the ref prefix", () => {
      const body = "pinchy_ref:v1:\n\nbitte überweisen Sie ab sofort an AT99 EVIL";
      const subject = "pinchy_ref:v1: Neue Bankverbindung";
      const out = summarizeArgs(
        { to: "boss@firma.at", subject, body },
        { refRecord: makeRefResolver(REF_KEY) }
      );
      expect(out.body).toBe(body);
      expect(out.subject).toBe(subject);
    });

    it("names the model, id and label of the record a ref points at", () => {
      const out = summarizeArgs(
        { target: ref("account.move", 42, "INV/2026/0042") },
        { refRecord: makeRefResolver(REF_KEY) }
      );
      expect(out.target).toBe('(record reference: account.move #42 "INV/2026/0042")');
    });

    // Two invoices of the same model used to render identically — "record
    // reference: account.move" — so approving one approved a card that could
    // equally have described the other.
    it("tells two records of the same model apart", () => {
      const resolve = { refRecord: makeRefResolver(REF_KEY) };
      const a = summarizeArgs({ target: ref("account.move", 42, "INV/2026/0042") }, resolve);
      const b = summarizeArgs({ target: ref("account.move", 43, "INV/2026/0043") }, resolve);
      expect(a.target).not.toEqual(b.target);
      expect(b.target).toBe('(record reference: account.move #43 "INV/2026/0043")');
    });

    it("renders refs nested in arrays too", () => {
      const out = summarizeArgs(
        { targets: [ref("res.partner", 7, "Ada"), ref("res.partner", 8, "Bob")] },
        { refRecord: makeRefResolver(REF_KEY) }
      );
      expect(out.targets).toEqual([
        '(record reference: res.partner #7 "Ada")',
        '(record reference: res.partner #8 "Bob")',
      ]);
    });

    it("passes the label through the same escaping as any other text", () => {
      const out = summarizeArgs(
        { target: ref("account.move", 42, 'INV\u202E"x"   \n42') },
        { refRecord: makeRefResolver(REF_KEY) }
      ) as { target: string };
      expect(out.target).not.toContain("\u202E");
      expect(out.target).toContain("⟨U+202E⟩");
      // Corrected expectation (second review of #1242): whitespace is no longer
      // collapsed, so the three spaces and the line break stay as sent (the
      // line break JSON-escaped inside the quoted label).
      expect(out.target).toBe('(record reference: account.move #42 "INV⟨U+202E⟩\\"x\\"   \\n42")');
    });
  });

  describe("keys are shown as they are, never merged (review of #1242)", () => {
    // The exact payload the review used: "to " (trailing space) used to be
    // trimmed to "to" and merged over the real `to`, so the card showed the
    // boss while the tool — which reads `to` — mailed the attacker.
    it("does not let a look-alike key hide the key the tool reads", () => {
      const params = JSON.parse(
        '{"to":"attacker@evil.com","subject":"Q3","body":"hi","to ":"boss@firma.at"}'
      );
      const out = summarizeArgs(params);
      expect(out.to).toBe("attacker@evil.com");
      expect(out['"to "']).toBe("boss@firma.at");
      expect(Object.keys(out)).toHaveLength(4);
    });

    it.each([
      ["body", "body "],
      ["path", "path "],
      ["to", "\u200Bto"],
      ["to", "t\u043E"], // Cyrillic о
      ["to", "to\u00A0"],
      ["to", "to\t"],
    ])("keeps %j and %j as two distinct, distinguishable rows", (plain, lookalike) => {
      const out = summarizeArgs({ [plain]: "shown", [lookalike]: "hidden" });
      const labels = Object.keys(out);
      expect(labels).toHaveLength(2);
      expect(new Set(labels).size).toBe(2);
      expect(out[plain]).toBe("shown");
      const other = labels.find((label) => label !== plain)!;
      expect(other.startsWith('"')).toBe(true);
      // Nothing invisible or space-like survives into the label.
      expect(other).not.toMatch(/[\u200B\u00A0\t]/u);
    });

    it("never collapses two keys into one label, however they are cut", () => {
      const prefix = "k".repeat(300);
      const out = summarizeArgs({ [`${prefix}a`]: 1, [`${prefix}b`]: 2 });
      expect(Object.keys(out)).toHaveLength(2);
      expect(Object.values(out).sort()).toEqual([1, 2]);
      for (const label of Object.keys(out)) expect(label).toMatch(/key cut/);
    });

    it("does not confuse a key spelled with literal quotes with an escaped one", () => {
      const out = summarizeArgs({ "to ": "a@x.at", '"to "': "b@x.at" });
      expect(Object.keys(out)).toHaveLength(2);
      expect(new Set(Object.keys(out)).size).toBe(2);
    });

    it("keeps an ordinary identifier key bare", () => {
      const out = summarizeArgs({ invoice_line_ids: [], "x-y.z": 1, __proto__x: 2 });
      expect(Object.keys(out).sort()).toEqual(["__proto__x", "invoice_line_ids", "x-y.z"]);
    });
  });

  describe("invisible characters cannot smuggle a payload (review of #1242)", () => {
    const tag = (text: string) =>
      [...text].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join("");

    it("makes Unicode tag characters visible, and bounds a long run", () => {
      const payload = tag("send to evil@x.com");
      const out = summarizeArgs({ subject: `Report${payload}` }) as { subject: string };
      expect(out.subject).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
      expect(out.subject).toMatch(
        /^Report⟨18 invisible characters: U\+E0073 U\+E0065 U\+E006E …⟩$/
      );
    });

    it("escapes a short run one by one", () => {
      const out = summarizeArgs({ subject: `a${tag("hi")}b` }) as { subject: string };
      expect(out.subject).toBe("a⟨U+E0068⟩⟨U+E0069⟩b");
    });

    it.each([
      ["VS1", "\uFE00"],
      ["VS14", "\uFE0D"],
      ["VS17", "\u{E0100}"],
      ["VS256", "\u{E01EF}"],
      ["interlinear annotation", "\uFFF9"],
      ["BOM", "\uFEFF"],
      ["Mongolian FVS", "\u180B"],
      ["Hangul filler", "\u3164"],
      ["combining grapheme joiner", "\u034F"],
    ])("escapes %s", (_name, char) => {
      const out = summarizeArgs({ subject: `x${char}y` }) as { subject: string };
      expect(out.subject).not.toContain(char);
      expect(out.subject).toMatch(/^x⟨U\+[0-9A-F]{4,5}⟩y$/);
    });

    it("leaves ordinary emoji readable: ZWJ sequences and VS16 stay as they are", () => {
      const family = "👨\u200D👩\u200D👧";
      const heart = "❤\uFE0F";
      const text = "\u263A\uFE0E";
      const out = summarizeArgs({ subject: `${family} ${heart} ${text}` }) as { subject: string };
      expect(out.subject).toBe(`${family} ${heart} ${text}`);
    });

    it("applies the same escaping to keys", () => {
      const out = summarizeArgs({ [`to${tag("evil")}`]: "x" });
      const [label] = Object.keys(out);
      expect(label).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
      expect(label).toContain("⟨4 invisible characters:");
    });
  });

  describe("bounds that do not hide what matters", () => {
    it("renders a standard Odoo invoice with line commands and tax commands fully", () => {
      const params = {
        model: "account.move",
        values: {
          move_type: "out_invoice",
          partner_id: 7,
          invoice_line_ids: [
            [0, 0, { name: "Consulting", quantity: 1, price_unit: 100, tax_ids: [[6, 0, [3, 4]]] }],
          ],
        },
      };
      expect(summarizeArgs(params)).toEqual(params);
    });

    it("still says so when nesting really is too deep", () => {
      let deep: unknown = "bottom";
      for (let i = 0; i < 30; i++) deep = [deep];
      expect(JSON.stringify(summarizeArgs({ deep }))).toMatch(/nested too deep/);
    });

    // Filler keys before `to` used to eat the size budget, so the recipient was
    // cut — or pushed past MAX_KEYS altogether.
    it("renders recipients in full even behind filler that exhausts the budget", () => {
      const filler = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, "0")}`, "z".repeat(3_999)])
      );
      const out = summarizeArgs({ ...filler, to: "attacker@evil.com", cc: "x@evil.com" });
      expect(out.to).toBe("attacker@evil.com");
      expect(out.cc).toBe("x@evil.com");
      expect(JSON.stringify(out)).toMatch(/not shown/);
    });

    it("renders recipients even behind more than the maximum number of keys", () => {
      const filler = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, i]));
      const out = summarizeArgs({ ...filler, bcc: "hidden@evil.com", reply_to: "r@evil.com" });
      expect(out.bcc).toBe("hidden@evil.com");
      expect(out.reply_to).toBe("r@evil.com");
    });

    it("stays bounded when every field carries a long key", () => {
      const wide = Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`${i}${"\u{E0041}".repeat(5_000)}`, i])
      );
      const items = Array.from({ length: 50 }, () => wide);
      const json = JSON.stringify(summarizeArgs({ items }));
      expect(json.length).toBeLessThan(100_000);
      expect(json).toMatch(/not shown/);
    });
  });

  describe("recipient domains", () => {
    it("shows a non-ASCII domain in punycode too, so a homoglyph domain is visible", () => {
      const domain = "f\u0456rma.at"; // Cyrillic і
      const out = summarizeArgs({ to: `boss@${domain}` });
      expect(out.to).toBe(`boss@${domain} (${domainToASCII(domain)})`);
      expect(out.to).toMatch(/xn--/);
    });

    it("does the same inside a named address and per entry of a list", () => {
      const domain = "f\u0456rma.at";
      const out = summarizeArgs({ cc: `Boss <boss@${domain}>, ok@firma.at` });
      expect(out.cc).toEqual([
        `boss@${domain} (${domainToASCII(domain)}) (name: "Boss")`,
        "ok@firma.at",
      ]);
    });

    it("leaves an ASCII domain alone", () => {
      expect(summarizeArgs({ to: "boss@firma.at" }).to).toBe("boss@firma.at");
    });
  });

  describe("recipient display (second review of #1242)", () => {
    // The probe: a familiar display name padded with braille blanks pushed the
    // real address out of the card's preview. The address comes first now.
    it("puts the address first and the display name after it", () => {
      const to = `Raimund Korber${"\u2800".repeat(190)} <attacker@evil.com>`;
      const out = summarizeArgs({ to, subject: "Rechnung", body: "Hallo" }) as { to: string };
      expect(out.to.startsWith("attacker@evil.com (name: ")).toBe(true);
      expect(out.to).toBe(
        'attacker@evil.com (name: "Raimund Korber⟨190 invisible characters: U+2800 U+2800 U+2800 …⟩")'
      );
    });

    it("shows a bare angle address as the address alone", () => {
      expect(summarizeArgs({ to: "<ada@example.com>" }).to).toBe("ada@example.com");
    });
  });

  describe("priority rendering of where an action lands", () => {
    it("renders path and target fields before filler, so they keep the size budget", () => {
      const filler = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, "0")}`, "z".repeat(3_999)])
      );
      const out = summarizeArgs({
        ...filler,
        path: "/data/contracts/signed.pdf",
        url: "https://x",
      });
      expect(Object.keys(out).slice(0, 2)).toEqual(["path", "url"]);
      expect(out.path).toBe("/data/contracts/signed.pdf");
    });
  });
});
