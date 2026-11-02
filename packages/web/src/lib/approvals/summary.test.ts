import { describe, it, expect, beforeAll } from "vitest";
import { domainToASCII } from "node:url";
import { describeRefusal, summarizeArgs, summarizeCall } from "./summary";
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

  // Corrected expectation (fourth review of #1242): a secret-like key hid ANY
  // value, so `payment_token_id: 7` and a whole object read as one opaque
  // redaction. Only text is hidden now — a number, boolean or null cannot be a
  // credential, and an object is shown field by field with its texts hidden.
  it("hides the texts inside an object under a secret-like key, and shows a null as null", () => {
    const out = summarizeArgs({ credentials: { user: "a", pass: "b" }, api_key: null });
    expect(out.credentials).toEqual({
      user: "[secret-like field is being set — value hidden, 1 character]",
      pass: "[secret-like field is being set — value hidden, 1 character]",
    });
    expect(out.api_key).toBeNull();
  });

  it("keeps a long string whole up to the stored limit, so the card can offer the full text", () => {
    const body = "a".repeat(500);
    expect(summarizeArgs({ body })).toEqual({ body });
  });

  // Corrected expectation (third review of #1242): the stored limit rose from
  // 4,000 to 20,000 characters, so an ordinary long body fits whole, and the
  // probe needs a longer string to cross it. A cut string now also makes the
  // call unapprovable (see "a call the card cannot show in full").
  // Corrected again (fourth review of #1242): the limit is now 200,000
  // characters of the text as sent, so the probe is 250,000 long.
  it("marks a string that exceeds the stored limit as truncated, and says by how much", () => {
    const out = summarizeArgs({ body: "a".repeat(250_000) }) as { body: string };
    expect(out.body).toMatch(/\[truncated: 50000 more characters not shown\]$/);
    expect(out.body.length).toBeLessThan(201_000);
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

    // Third review of #1242: email_send now accepts a quoted name with a
    // comma or parentheses; the card must show it as the one mailbox it is.
    it("shows a quoted name with parentheses as one recipient, address first", () => {
      expect(summarizeArgs({ to: '"Raimund Korber (Noack)" <r@noack.at>' }).to).toBe(
        'r@noack.at (name: "Raimund Korber (Noack)")'
      );
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

    // Corrected expectation (third review of #1242): the caps rose to 100 keys
    // and 200 items, so the probes are sized past the new caps.
    it("says so when keys, items or depth are cut, never silently drops them", () => {
      const manyKeys = Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`k${i}`, i]));
      expect(JSON.stringify(summarizeArgs(manyKeys))).toMatch(/more fields? not shown/);
      const manyItems = Array.from({ length: 250 }, (_, i) => i);
      expect(JSON.stringify(summarizeArgs({ ids: manyItems }))).toMatch(/more items? not shown/);
      let deep: unknown = "bottom";
      for (let i = 0; i < 20; i++) deep = { n: deep };
      expect(JSON.stringify(summarizeArgs({ deep }))).toMatch(/not shown/);
    });

    // Corrected expectation (third review of #1242): the total budget rose
    // from 16,000 to 64,000 characters, so the bound sits higher. Corrected
    // again (fourth review): the budget is now 512,000, and so is the probe.
    it("bounds the total size, and says that it did", () => {
      const huge = Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`k${i}`, "z".repeat(25_000)])
      );
      const json = JSON.stringify(summarizeArgs(huge));
      expect(json.length).toBeLessThan(530_000);
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

  // Fifth review of #1242: Node's base64url decoder stops at the first `=` and
  // drops the rest, so `<valid ref>=\n\n<any text>` still decoded. The card
  // showed only "(record reference: …)" — and skipped the length check — while
  // the tool received the whole string: an email body hiding a payment
  // instruction behind a ref. Only the exact string the encoder writes is a
  // ref; anything longer is text, shown and counted like any other.
  describe("a ref with anything after it is text (fifth review of #1242)", () => {
    const partner = () =>
      encodeRef({
        integrationType: "odoo",
        connectionId: "c1",
        model: "res.partner",
        id: 7,
        label: "Raimund Korber",
      });
    const hidden = "Bitte überweisen Sie 9.800 € an AT00 1234 5678 9012";

    it.each([
      ["padding then a hidden message", `=\n\n${hidden}`],
      ["double padding then text", `==x ${hidden}`],
      ["a space then text", ` ${hidden}`],
      ["padding then text", `=${hidden}`],
    ])("shows the whole string for a ref followed by %s", (_name, suffix) => {
      const body = partner() + suffix;
      const out = summarizeArgs(
        { to: "kunde@example.com", body },
        { refRecord: makeRefResolver(REF_KEY) }
      ) as { body: string };
      expect(out.body).not.toContain("record reference");
      expect(out.body).toContain("AT00 1234 5678 9012");
    });

    it("shows a padded ref as text, not as the record", () => {
      const body = partner() + "=";
      const out = summarizeArgs({ body }, { refRecord: makeRefResolver(REF_KEY) });
      expect(out.body).toBe(body);
    });

    // The card must not depend on every resolver being strict: the shape is
    // checked here too, so a resolver that answers for anything still cannot
    // hide text behind a record.
    it("does not let a lenient resolver turn trailing text into a record", () => {
      const anything = () => ({ model: "res.partner", id: 7, label: "Raimund Korber" });
      const body = `${partner()}=\n\n${hidden}`;
      const out = summarizeArgs({ body }, { refRecord: anything }) as { body: string };
      expect(out.body).toContain("AT00 1234 5678 9012");
      expect(out.body).not.toContain("record reference");
    });

    it("counts the trailing text against the length limit", () => {
      const body = `${partner()}=${"a".repeat(200_001)}`;
      const result = summarizeCall({ body }, { refRecord: makeRefResolver(REF_KEY) });
      expect(result.incomplete).toBe(true);
      expect(result.exceeded).toMatchObject({ kind: "text-too-long", at: "body" });
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

    // Sixth review of #1242: the joiner and the presentation selectors were
    // kept raw everywhere, so "Noack\u200D GmbH" read as "Noack GmbH" — a
    // different name to look up — and "RE-1001\uFE0F" as "RE-1001", which the
    // vendor-bill duplicate check compares exactly. Outside an emoji they
    // render as nothing, so they are marked like any other invisible character.
    it("marks a joiner or presentation selector that is not part of an emoji", () => {
      const out = summarizeArgs({
        model: "account.move",
        values: { partner_id: "Noack\u200D GmbH", ref: "RE-1001\uFE0F", note: "a\uFE0Eb" },
      }) as { values: Record<string, string> };
      expect(out.values).toEqual({
        partner_id: "Noack⟨U+200D⟩ GmbH",
        ref: "RE-1001⟨U+FE0F⟩",
        note: "a⟨U+FE0E⟩b",
      });
    });

    // Seventh review of #1242: a ZWNJ was marked everywhere and a ZWJ outside
    // an emoji, although in Arabic-script and Indic text they shape what you
    // see. Kept as they are where RFC 5892's CONTEXTJ rule says they do
    // something — after a virama, and a ZWNJ between letters that would
    // otherwise join — and marked where they render as nothing.
    it("leaves a joiner that shapes Arabic-script or Indic text as it is", () => {
      const text = "گزارش\u200Cها ශ්\u200Dරී അവന്\u200D क्\u200Cष";
      expect(summarizeArgs({ subject: text, path: `/data/output/${text}.md` })).toEqual({
        path: `/data/output/${text}.md`,
        subject: text,
      });
    });

    it.each([
      ["a ZWNJ between Latin letters", "a\u200Cb", "a⟨U+200C⟩b"],
      ["a ZWNJ after a right-joining letter", "محمد\u200Cرضا", "محمد⟨U+200C⟩رضا"],
      ["a ZWJ between Arabic letters", "ش\u200Dه", "ش⟨U+200D⟩ه"],
      // Eighth review of #1242: nothing after the virama for the ZWNJ to keep
      // apart, or a virama on a letter of another script.
      ["a ZWNJ after a virama at the end", "जगत्\u200C.md", "जगत्⟨U+200C⟩.md"],
      ["a ZWNJ after a virama on a Latin letter", "a्\u200Cb.md", "a्⟨U+200C⟩b.md"],
    ])("marks %s", (_label, text, shown) => {
      expect(summarizeArgs({ subject: text })).toEqual({ subject: shown });
    });

    it.each([
      ["a joiner trailing an emoji", "\u{1F468}\u200D.", "\u{1F468}⟨U+200D⟩."],
      ["a joiner before an emoji", "a\u200D\u{1F468}", "a⟨U+200D⟩\u{1F468}"],
      ["a second selector", "\u26A0\uFE0F\uFE0F", "\u26A0\uFE0F⟨U+FE0F⟩"],
    ])("marks %s", (_label, text, shown) => {
      expect(summarizeArgs({ subject: text })).toEqual({ subject: shown });
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
    // Corrected probe (fourth review of #1242): the budget rose to 512,000,
    // so the filler grows past it to keep exhausting it.
    it("renders recipients in full even behind filler that exhausts the budget", () => {
      const filler = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, "0")}`, "z".repeat(15_000)])
      );
      const out = summarizeArgs({ ...filler, to: "attacker@evil.com", cc: "x@evil.com" });
      expect(out.to).toBe("attacker@evil.com");
      expect(out.cc).toBe("x@evil.com");
      expect(JSON.stringify(out)).toMatch(/not shown/);
    });

    // Corrected expectation (third review of #1242): MAX_KEYS rose from 25 to
    // 100, so the filler grows past it to keep testing what the name says.
    it("renders recipients even behind more than the maximum number of keys", () => {
      const filler = Object.fromEntries(Array.from({ length: 160 }, (_, i) => [`k${i}`, i]));
      const out = summarizeArgs({ ...filler, bcc: "hidden@evil.com", reply_to: "r@evil.com" });
      expect(out.bcc).toBe("hidden@evil.com");
      expect(out.reply_to).toBe("r@evil.com");
    });

    // Corrected bound (fourth review of #1242): the total budget rose from
    // 64,000 to 512,000, so the summary may be larger — but against 12.5
    // million characters of keys sent, it still stays within the budget's
    // documented ceiling of about twice MAX_TOTAL_CHARS.
    it("stays bounded when every field carries a long key", () => {
      const wide = Object.fromEntries(
        Array.from({ length: 25 }, (_, i) => [`${i}${"\u{E0041}".repeat(5_000)}`, i])
      );
      const items = Array.from({ length: 50 }, () => wide);
      const json = JSON.stringify(summarizeArgs({ items }));
      expect(json.length).toBeLessThan(1_100_000);
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

  // Sixth review of #1242: a target names one file or record, and two names
  // that render alike are two targets. Where an action lands, what renders as
  // nothing is marked even where ordinary text keeps it.
  describe("where an action lands reads as exactly one target", () => {
    it.each([
      ["a trailing space", "/data/out/report.md ", "/data/out/report.md⟨U+0020⟩"],
      ["a leading space", " /data/out/report.md", "⟨U+0020⟩/data/out/report.md"],
      ["a trailing line break", "/data/out/report.md\n", "/data/out/report.md⟨U+000A⟩"],
      ["a trailing tab", "/data/out/report.md\t", "/data/out/report.md⟨U+0009⟩"],
      ["four trailing spaces", "/data/out/report.md    ", "/data/out/report.md⟨4 spaces⟩"],
    ])("marks %s around a path", (_label, path, shown) => {
      expect(summarizeArgs({ path })).toEqual({ path: shown });
    });

    it("marks the edges of every entry in a list of targets", () => {
      expect(summarizeArgs({ paths: ["/a.md ", "/b.md"] })).toEqual({
        paths: ["/a.md⟨U+0020⟩", "/b.md"],
      });
    });

    it("keeps spaces inside a path, and around ordinary text", () => {
      expect(summarizeArgs({ path: "/data/Q3 Bericht.md", subject: " hi " })).toEqual({
        path: "/data/Q3 Bericht.md",
        subject: " hi ",
      });
    });

    it.each([
      [
        "a check mark",
        "/data/out/Vertrag \u2705\uFE0F.pdf",
        "/data/out/Vertrag \u2705⟨U+FE0F⟩.pdf",
      ],
      ["a page", "/data/out/\u{1F4C4}\uFE0F.md", "/data/out/\u{1F4C4}⟨U+FE0F⟩.md"],
    ])("marks a presentation selector that changes nothing after %s", (_label, path, shown) => {
      expect(summarizeArgs({ path })).toEqual({ path: shown });
    });

    it.each([
      ["a warning sign shown as emoji", "/data/notes/\u26A0\uFE0F offen.md"],
      ["a check mark shown as text", "/data/out/Vertrag \u2705\uFE0E.pdf"],
      ["a joined family", "/data/notes/\u{1F468}\u200D\u{1F469}\u200D\u{1F467} Familie.md"],
      ["a rainbow flag", "/data/notes/\u{1F3F3}\uFE0F\u200D\u{1F308} Pride.md"],
      ["a keycap", "/data/notes/1\uFE0F\u20E3 first.md"],
    ])("leaves %s as it is", (_label, path) => {
      expect(summarizeArgs({ path })).toEqual({ path });
    });
  });
  // Third review of #1242: a marker that says "N more fields not shown" is
  // honest, but a person still approved a call whose hidden part runs. A call
  // whose summary lost anything is reported incomplete, and the gate refuses it.
  describe("a call the card cannot show in full is never approvable", () => {
    const odooWrite26 = () => {
      const values: Record<string, unknown> = {};
      for (let i = 0; i < 25; i++) values[`x_note_${i}`] = "ok";
      values.acc_number = "AT61 1904 3002 3457 3201";
      return { model: "res.partner.bank", ids: [7], values };
    };

    it("shows an Odoo write with 26 fields in full, the bank account included", () => {
      const params = odooWrite26();
      const { summary, incomplete } = summarizeCall(params);
      expect(incomplete).toBe(false);
      expect(summary).toEqual(params);
      expect(JSON.stringify(summary)).not.toMatch(/not shown/);
    });

    it("shows an ordinary Odoo invoice create with lines and taxes in full", () => {
      const line = (name: string, price: number) => [
        0,
        0,
        {
          name,
          product_id: 12,
          quantity: 3,
          price_unit: price,
          discount: 0,
          account_id: 400,
          analytic_distribution: { "7": 100 },
          tax_ids: [[6, 0, [3, 4]]],
        },
      ];
      const params = {
        model: "account.move",
        values: {
          move_type: "out_invoice",
          partner_id: 7,
          partner_bank_id: 3,
          invoice_date: "2026-11-02",
          invoice_date_due: "2026-12-02",
          invoice_payment_term_id: 2,
          ref: "PO-4711",
          narration: "Zahlbar innerhalb von 30 Tagen ohne Abzug. ".repeat(20),
          invoice_line_ids: Array.from({ length: 40 }, (_, i) => line(`Consulting ${i}`, 100 + i)),
        },
      };
      const { summary, incomplete } = summarizeCall(params);
      expect(incomplete).toBe(false);
      expect(summary).toEqual(params);
    });

    it.each([
      [
        "more keys than an object shows",
        () => ({
          values: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i])),
        }),
      ],
      ["more items than an array shows", () => ({ ids: Array.from({ length: 201 }, (_, i) => i) })],
      [
        "deeper nesting than the card shows",
        () => {
          let deep: unknown = "bottom";
          for (let i = 0; i < 12; i++) deep = { n: deep };
          return { deep };
        },
      ],
      // Probe sized to the fourth review's limit of 200,000 characters.
      ["a string longer than the stored limit", () => ({ body: "a".repeat(200_001) })],
      ["a key longer than the label limit", () => ({ ["k".repeat(101)]: 1 })],
      [
        "more recipients than a list shows",
        () => ({
          to: Array.from({ length: 201 }, (_, i) => `a${i}@x.at`).join(", "),
        }),
      ],
    ])("reports %s as incomplete", (_label, build) => {
      expect(summarizeCall(build()).incomplete).toBe(true);
    });

    // The review's budget probe: four long strings used up the budget, and the
    // field after them — the bank account the invoice is paid to — became
    // "1 more field not shown". It is never silently dropped and approved.
    // Probe sized to the fourth review's budget of 512,000 characters.
    it("reports a call that exhausts the total budget as incomplete, never drops a key quietly", () => {
      const params = {
        model: "account.move",
        ids: [42],
        values: {
          narration: "a".repeat(150_000),
          ref: "b".repeat(150_000),
          x1: "c".repeat(150_000),
          x2: "d".repeat(150_000),
          partner_bank_id: 666,
        },
      };
      const { summary, incomplete } = summarizeCall(params);
      expect(incomplete).toBe(true);
      expect(JSON.stringify(summary)).toMatch(/not shown/);
    });

    it("reports a call that fits as complete", () => {
      expect(
        summarizeCall({ to: "a@x.at", subject: "Hi", body: "x".repeat(20_000) }).incomplete
      ).toBe(false);
    });

    it("renders model and ids before anything else, as targets", () => {
      const out = summarizeArgs({ values: { a: 1 }, ids: [7], model: "res.partner" });
      expect(Object.keys(out)).toEqual(["ids", "model", "values"]);
    });
  });

  // Third review of #1242: the punycode form was only appended to recipients.
  // An Odoo `values.email` or `website` with a Cyrillic "і" read exactly like
  // the real domain.
  describe("homoglyph hosts anywhere in the call", () => {
    const domain = "f\u0456rma.at"; // Cyrillic і
    const ascii = domainToASCII(domain);

    it("appends the punycode form to an email-shaped value at any key and depth", () => {
      const out = summarizeArgs({
        model: "res.partner",
        ids: [7],
        values: { email: `billing@${domain}`, website: `https://${domain}/pay` },
      }) as { values: Record<string, string> };
      expect(out.values.email).toBe(`billing@${domain} (${ascii})`);
      expect(out.values.website).toBe(`https://${domain}/pay (${ascii})`);
    });

    it("does so inside arrays, and for a URL with credentials and a port", () => {
      const out = summarizeArgs({ links: [`http://user@${domain}:8080/x`] }) as { links: string[] };
      expect(out.links[0]).toBe(`http://user@${domain}:8080/x (${ascii})`);
    });

    it("leaves ASCII hosts and free text alone", () => {
      const out = summarizeArgs({
        email: "billing@firma.at",
        website: "https://firma.at",
        note: `Schreib an billing@${domain} bitte`,
      });
      expect(out.email).toBe("billing@firma.at");
      expect(out.website).toBe("https://firma.at");
      expect(out.note).toBe(`Schreib an billing@${domain} bitte`);
    });
  });

  // Third review of #1242: a cut could land between the two halves of an
  // emoji, and a lone surrogate in the input went into the summary as it was.
  // Postgres rejects either in jsonb ("Unicode low surrogate must follow a
  // high surrogate"), so the row could not even be stored.
  describe("surrogates", () => {
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    // Corrected probe (fourth review of #1242): one string no longer reaches
    // the budget, so a filler field spends most of it first; with and without
    // a leading "a", one of the two cuts lands on a pair boundary.
    it("never cuts a string between the halves of an emoji", () => {
      for (const lead of ["", "a"]) {
        const out = summarizeArgs({
          a: "z".repeat(199_000),
          body: `${lead}${"😀".repeat(199_000)}`,
        }) as { body: string };
        expect(out.body).toMatch(/not shown\]$/);
        expect(LONE.test(out.body)).toBe(false);
        expect(JSON.stringify(out)).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
      }
    });

    it("escapes a lone surrogate in the input as a marker", () => {
      const out = summarizeArgs({ subject: "a\uD83Db", ["k\uDE00"]: 1 }) as Record<string, unknown>;
      expect(out.subject).toBe("a⟨U+D83D⟩b");
      const json = JSON.stringify(out);
      expect(LONE.test(json)).toBe(false);
      expect(json).not.toMatch(/\\ud[89abcdef][0-9a-f]{2}/i);
    });
  });

  // Third review of #1242: a Windows line break showed as "⟨U+000D⟩" followed
  // by a break — noise on every mail body written with CRLF.
  describe("line breaks", () => {
    it("renders CRLF as a line break", () => {
      const out = summarizeArgs({ body: "Sehr geehrte Damen,\r\n\r\nanbei die Rechnung.\r\nMax" });
      expect(out.body).toBe("Sehr geehrte Damen,\n\nanbei die Rechnung.\nMax");
    });

    it("counts a long run of CRLFs as line breaks", () => {
      expect(summarizeArgs({ body: `a${"\r\n".repeat(6)}b` }).body).toBe("a⟨6 line breaks⟩b");
    });

    it("keeps a lone carriage return escaped", () => {
      expect(summarizeArgs({ body: "a\rb\n\rc" }).body).toBe("a⟨U+000D⟩b\n⟨U+000D⟩c");
    });
  });

  // Fourth review of #1242: the per-string limit was 20,000 characters of the
  // ESCAPED text, so a gated pinchy_write of a 25 KB report, or a mail body
  // with no-break spaces (each shown as an 8-character marker), could never be
  // confirmed — and "split it into smaller calls" is advice nobody can follow
  // for one file or one mail.
  describe("long texts (fourth review of #1242)", () => {
    it("lets a gated pinchy_write of a 30,000-character report through, stored whole", () => {
      const content = "Quarterly report line.\n".repeat(1_305).slice(0, 30_000);
      const { summary, incomplete, exceeded } = summarizeCall({
        path: "/data/out/report.md",
        content,
      });
      expect(incomplete).toBe(false);
      expect(exceeded).toBeNull();
      expect(summary.content).toBe(content);
    });

    it("measures a text by its own length, not by the markers it is shown with", () => {
      // 18,000 characters, one in eight a no-break space: shown, each NBSP is an
      // eight-character marker, so the rendered text is far past 20,000.
      const body = "Preis € ".repeat(2_250);
      expect([...body].length).toBe(18_000);
      const { summary, incomplete } = summarizeCall({ to: "a@b.at", subject: "s", body });
      expect(incomplete).toBe(false);
      expect(summary.body).toBe(body.replaceAll(" ", "⟨U+00A0⟩"));
    });

    it("refuses a 250,000-character text, and says which value, how long, and the limit", () => {
      const { incomplete, exceeded } = summarizeCall({
        path: "/data/out/dump.txt",
        content: "x".repeat(250_000),
      });
      expect(incomplete).toBe(true);
      expect(exceeded).toEqual({
        kind: "text-too-long",
        at: "content",
        length: 250_000,
        limit: 200_000,
      });
    });

    it("counts code points, so an emoji is one character", () => {
      expect(summarizeCall({ body: "😀".repeat(200_000) }).incomplete).toBe(false);
      expect(summarizeCall({ body: "😀".repeat(200_001) }).exceeded).toMatchObject({
        kind: "text-too-long",
        length: 200_001,
      });
    });

    it("names the path of a nested value that is too long", () => {
      const { exceeded } = summarizeCall({
        model: "res.partner",
        values: { comment: "x".repeat(200_001) },
        lines: [{ note: "ok" }],
      });
      expect(exceeded).toMatchObject({ kind: "text-too-long", at: "values.comment" });
      expect(
        summarizeCall({ lines: [{ note: "ok" }, { note: "x".repeat(200_001) }] }).exceeded
      ).toMatchObject({ at: "lines[1].note" });
    });

    it("still bounds what is stored: a text whose markers blow past the total is refused", () => {
      // 150,000 characters, every other one invisible: within the per-text
      // limit, but shown as ~700,000 characters — more than the row may hold.
      const { incomplete, exceeded } = summarizeCall({ body: "a\u{E0041}".repeat(75_000) });
      expect(incomplete).toBe(true);
      expect(exceeded).toEqual({ kind: "too-large-in-all", limit: 512_000 });
    });
  });

  // Fourth review of #1242: numbers, booleans, null and empty containers
  // cost nothing, so 200×200×50 numbers produced a 5.7 MB summary.
  describe("every value counts against the total (fourth review of #1242)", () => {
    const grid = (a: number, b: number, c: number) =>
      Array.from({ length: a }, () =>
        Array.from({ length: b }, () => Array.from({ length: c }, (_, i) => i))
      );

    it("refuses 200×200×50 numbers as too large in all, and stays bounded", () => {
      const { summary, incomplete, exceeded } = summarizeCall({ rows: grid(200, 200, 50) });
      expect(incomplete).toBe(true);
      expect(exceeded).toEqual({ kind: "too-large-in-all", limit: 512_000 });
      expect(JSON.stringify(summary).length).toBeLessThan(1_100_000);
    });

    it("refuses a grid of empty objects past the budget", () => {
      const empties = Array.from({ length: 200 }, () =>
        Array.from({ length: 200 }, () => Array.from({ length: 10 }, () => ({})))
      );
      const { incomplete, summary } = summarizeCall({ a: empties });
      expect(incomplete).toBe(true);
      expect(JSON.stringify(summary).length).toBeLessThan(1_100_000);
    });

    it("still shows a 200×200 grid of numbers in full", () => {
      const rows = grid(1, 200, 200)[0];
      const { summary, incomplete } = summarizeCall({ rows });
      expect(incomplete).toBe(false);
      expect(summary.rows).toEqual(rows);
    });
  });

  describe("what the refusal says (fourth review of #1242)", () => {
    it.each([
      [
        "too many fields",
        { values: Object.fromEntries(Array.from({ length: 101 }, (_, i) => [`k${i}`, i])) },
        { kind: "too-many-fields", at: "values", count: 101, limit: 100 },
      ],
      [
        "too many items",
        { ids: Array.from({ length: 201 }, (_, i) => i) },
        { kind: "too-many-items", at: "ids", count: 201, limit: 200 },
      ],
      [
        "too many recipients",
        { to: Array.from({ length: 201 }, (_, i) => `a${i}@x.at`).join(", ") },
        { kind: "too-many-recipients", at: "to", count: 201, limit: 200 },
      ],
      [
        "a key too long",
        { values: { ["k".repeat(101)]: 1 } },
        { kind: "key-too-long", at: "values", length: 101, limit: 100 },
      ],
    ])("reports %s, where, and the limit", (_label, params, expected) => {
      expect(summarizeCall(params).exceeded).toEqual(expected);
    });

    it("reports nesting that is too deep, and where", () => {
      let deep: unknown = "bottom";
      for (let i = 0; i < 12; i++) deep = { n: deep };
      expect(summarizeCall({ deep }).exceeded).toMatchObject({
        kind: "nested-too-deep",
        limit: 10,
      });
    });

    it("tells the agent to split a call only when splitting can help", () => {
      const split = /split it into smaller calls/i;
      expect(
        describeRefusal({ kind: "text-too-long", at: "content", length: 250_000, limit: 200_000 })
      ).not.toMatch(split);
      const long = describeRefusal({
        kind: "text-too-long",
        at: "content",
        length: 250_000,
        limit: 200_000,
      });
      expect(long).toMatch(/content/);
      expect(long).toMatch(/250,000/);
      expect(long).toMatch(/200,000/);
      expect(long).toMatch(/too long to show for approval/i);
      expect(
        describeRefusal({ kind: "too-many-items", at: "ids", count: 201, limit: 200 })
      ).toMatch(split);
      expect(describeRefusal({ kind: "too-large-in-all", limit: 512_000 })).toMatch(split);
      expect(describeRefusal({ kind: "nested-too-deep", at: "deep", limit: 10 })).not.toMatch(
        split
      );
    });
  });

  // Fourth review of #1242: the secret rule matched by key substring and hid
  // ANY value — `payment_token_id: 7`, `token_ids: [1, 2]`, a whole object
  // with a recipient in it.
  describe("secret-like keys hide text, not record ids (fourth review of #1242)", () => {
    it("shows a number, boolean or null under a secret-like key", () => {
      const out = summarizeArgs({ access_token: 7, has_password: true, api_key: null });
      expect(out).toEqual({ access_token: 7, has_password: true, api_key: null });
    });

    it("shows record ids under keys ending in _id / _ids in full", () => {
      const out = summarizeArgs({
        model: "account.payment",
        values: { payment_token_id: 7, token_ids: [[6, 0, [1, 2]]], api_key_ids: "3" },
      }) as { values: Record<string, unknown> };
      expect(out.values).toEqual({
        payment_token_id: 7,
        token_ids: [[6, 0, [1, 2]]],
        api_key_ids: "3",
      });
    });

    it("recurses into an object under a secret-like key, hiding the texts in it", () => {
      const out = summarizeArgs({
        x_credential_info: { to: "attacker@evil.com", port: 993, ssl: true },
      });
      expect(out.x_credential_info).toEqual({
        to: "[secret-like field is being set — value hidden, 17 characters]",
        port: 993,
        ssl: true,
      });
      expect(JSON.stringify(out)).not.toContain("evil.com");
    });
  });

  // Fourth review of #1242: the host was read with a regex, which disagrees
  // with the URL parser the tool uses — `https://fіrma.at\@evil.com/x` read as
  // evil.com, while WHATWG resolves the host to fіrma.at (a backslash is a
  // path separator in a special URL).
  describe("the host a URL resolves to (fourth review of #1242)", () => {
    it("annotates the host the URL parser resolves, not the one a regex reads", () => {
      const value = "https://fіrma.at\\@evil.com/x";
      const out = summarizeArgs({ url: value });
      expect(out.url).toBe(`${value} (${new URL(value).hostname})`);
      expect(new URL(value).hostname).toBe("xn--frma-l9d.at");
    });

    it("names the real host when the text reads as a different one", () => {
      const value = "https://evil.com\\@firma.at/x";
      expect(summarizeArgs({ website: value }).website).toBe(`${value} (evil.com)`);
    });

    it("names the host behind percent-encoding and numeric forms", () => {
      expect(summarizeArgs({ url: "https://fir%6Da.at/" }).url).toBe(
        "https://fir%6Da.at/ (firma.at)"
      );
      expect(summarizeArgs({ url: "http://0x7f.1/" }).url).toBe("http://0x7f.1/ (127.0.0.1)");
    });

    it("leaves a URL whose host reads as it resolves alone, case aside", () => {
      expect(summarizeArgs({ url: "https://Firma.at/pay" }).url).toBe("https://Firma.at/pay");
    });
  });
});
