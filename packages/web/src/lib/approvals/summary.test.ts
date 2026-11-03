import { describe, it, expect, beforeAll } from "vitest";
import { domainToASCII } from "node:url";
import { describeRefusal, markScripts, summarizeCall } from "./summary";
import { summarizeArgs } from "@/test-helpers/approvals";
import { makeRefResolver } from "./call-models";
import {
  ASTRAL_COST,
  DRAW_BUDGET,
  WHOLE_MAX,
  drawCost,
  drawnOf,
  inStoredOrder,
  readNode,
  readShown,
  textOf,
  type Shown,
} from "./display";
// The pinchy-odoo encoder, so the ref rendering is tested against real refs —
// see call-models.test.ts for why this crosses the package boundary.
import { encodeRef, _resetKeyCacheForTest } from "../../../../plugins/pinchy-odoo/integration-ref";

const REF_KEY = "b".repeat(64);

/*
 * What the summary says ABOUT a value — a hidden
 * secret, a record a ref names, a host, a display name — is a node of its own
 * (`SummaryNode`), never text written into the value. These build the nodes
 * the expectations below compare against.
 */
const secret = (length: number) => ({ "@": "secret", length });
const recordRef = (model: string, id: number, label: string) => ({
  "@": "ref",
  model,
  id,
  label,
  labelCut: 0,
});
const named = (text: string, name: string) => ({
  "@": "noted",
  text,
  notes: [{ kind: "name", name }],
});
const hosted = (text: string, host: string) => ({
  "@": "noted",
  text,
  notes: [{ kind: "host", host }],
});
/** The text of a summary value, whether the card draws it whole or previews it. */
const textIn = (value: unknown): string => textOf(value as Shown);

/** A summary with every previewed text replaced by the text itself: the call as sent. */
function plain(value: unknown): unknown {
  const node = readNode(value);
  if (node !== "unreadable" && node?.["@"] === "previewed") return node.text;
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, plain(v)]));
  }
  return value;
}

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

  // A bare "[redacted]" would hide that a secret-like field is being SET at
  // all — an attacker-chosen access_token would look like any other
  // redaction. The value stays hidden (it may be a real secret), but the
  // effect is spelled out.
  it("hides secret-looking values but says that one is being set, and how long it is", () => {
    const out = summarizeArgs({ apiKey: "sk-123", password: "p", auth_token: "t", to: "x@y.z" });
    expect(out.apiKey).toEqual(secret(6));
    expect(out.password).toEqual(secret(1));
    expect(out.auth_token).toEqual(secret(1));
    expect(out.to).toBe("x@y.z");
  });

  it("makes an attacker-chosen token written into a record visible as a write", () => {
    const out = summarizeArgs({
      model: "res.users",
      ids: [2],
      values: { access_token: "attacker-known-0000", name: "Ada" },
    }) as { values: Record<string, unknown> };
    expect(out.values.access_token).toEqual(secret(19));
    expect(JSON.stringify(out)).not.toContain("attacker-known-0000");
  });

  // Hiding ANY value under a secret-like key made `payment_token_id: 7` and a
  // whole object read as one opaque redaction. Only text is hidden — a
  // number, boolean or null cannot be a credential, and an object is shown
  // field by field with its texts hidden.
  it("hides the texts inside an object under a secret-like key, and shows a null as null", () => {
    const out = summarizeArgs({ credentials: { user: "a", pass: "b" }, api_key: null });
    expect(out.credentials).toEqual({ user: secret(1), pass: secret(1) });
    expect(out.api_key).toBeNull();
  });

  // A node is marked by the key `@`. A value's own key is labelled bare only
  // when it is `[A-Za-z0-9_.-]+`, so the call's `@` is labelled `"@"`, and no
  // object the agent sends can read as a node.
  it("never lets an object in the call pass for a node", () => {
    const out = summarizeArgs({ values: { "@": "secret", length: 3 }, "@": "ref" });
    expect(out).toEqual({ values: { '"@"': "secret", length: 3 }, '"@"': "ref" });
    expect(readNode(out)).toBeNull();
    expect(readNode(out.values)).toBeNull();
  });

  it("stores only plain text where nothing is said about a value", () => {
    const out = summarizeArgs({
      email: "boss@f\u0456rma.at (xn--frma-l9d.at)",
      website: "boss@f\u0456rma.at (firma.at)",
      note: "[secret-like field is being set — value hidden, 3 characters]",
    });
    expect(out).toEqual({
      email: "boss@f\u0456rma.at (xn--frma-l9d.at)",
      website: "boss@f\u0456rma.at (firma.at)",
      note: "[secret-like field is being set — value hidden, 3 characters]",
    });
  });

  it("keeps a long string whole up to the stored limit, so the card can offer the full text", () => {
    const body = "a".repeat(500);
    expect(summarizeArgs({ body })).toEqual({
      body: expect.objectContaining({ "@": "previewed", text: body }),
    });
  });

  // The stored limit is 200,000 characters of the text as sent, so an
  // ordinary long body fits whole and the probe is 250,000 long. A cut string
  // also makes the call unapprovable (see "a call the card cannot show in
  // full").
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
    expect(JSON.stringify(out)).toContain('{"@":"secret","length":4}');
    expect(JSON.stringify(out)).toContain('{"@":"secret","length":7}');
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
      // Address first, display name after.
      expect(out.bcc).toEqual(named("f@evil.com", "Evil"));
    });

    it("does not split on a comma inside a quoted display name", () => {
      const out = summarizeArgs({ to: '"Meier, Hans" <hans@x.at>, b@x.at' });
      expect(out.to).toEqual([named("hans@x.at", "Meier, Hans"), "b@x.at"]);
    });

    // email_send accepts a quoted name with a comma or parentheses; the card
    // must show it as the one mailbox it is.
    it("shows a quoted name with parentheses as one recipient, address first", () => {
      expect(summarizeArgs({ to: '"Raimund Korber (Noack)" <r@noack.at>' }).to).toEqual(
        named("r@noack.at", "Raimund Korber (Noack)")
      );
    });

    it("keeps a single recipient as a plain string", () => {
      expect(summarizeArgs({ to: "ada@example.com" }).to).toBe("ada@example.com");
    });

    // Collapsing whitespace would rewrite the value, so the card would not
    // show the string as sent. The string is kept; plain spaces, tabs and line
    // breaks stay (the card renders them with pre-wrap), and every other
    // space-like character is escaped.
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

    // 180 braille blanks render as empty space,
    // so the path looked like a draft in reports/ while it resolved elsewhere.
    it("makes a path padded with blank-rendering characters readable", () => {
      const path = `/data/reports/old-draft.md${"\u2800".repeat(180)}/../../contracts/signed.pdf`;
      const out = summarizeArgs({ path }) as { path: string };
      expect(out.path).toBe("/data/reports/old-draft.md⟨180 × U+2800⟩/../../contracts/signed.pdf");
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

    // The caps are 100 keys and 200 items, so the probes are sized past them.
    it("says so when keys, items or depth are cut, never silently drops them", () => {
      const manyKeys = Object.fromEntries(Array.from({ length: 140 }, (_, i) => [`k${i}`, i]));
      expect(JSON.stringify(summarizeArgs(manyKeys))).toMatch(/more fields? not shown/);
      const manyItems = Array.from({ length: 250 }, (_, i) => i);
      expect(JSON.stringify(summarizeArgs({ ids: manyItems }))).toMatch(/more items? not shown/);
      let deep: unknown = "bottom";
      for (let i = 0; i < 20; i++) deep = { n: deep };
      expect(JSON.stringify(summarizeArgs({ deep }))).toMatch(/not shown/);
    });

    // The total budget is 512,000 characters, and so is the probe.
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

    // Stored as the text `(record reference: res.partner #7 "Acme GmbH")`, a
    // ref would be the very string an agent could send instead, which
    // pinchy-odoo resolves by NAME. The ref is a node; the text stays the
    // plain string it is.
    it("stores a ref as a node, and the text that spells it out as text", () => {
      const out = summarizeArgs(
        {
          partner_id: ref("res.partner", 7, "Acme GmbH"),
          name: '(record reference: res.partner #7 "Acme GmbH")',
        },
        { refRecord: makeRefResolver(REF_KEY) }
      );
      expect(out.partner_id).toEqual(recordRef("res.partner", 7, "Acme GmbH"));
      expect(out.name).toBe('(record reference: res.partner #7 "Acme GmbH")');
    });

    it("cuts a long label, says by how much, and still offers the call", () => {
      const result = summarizeCall(
        { target: ref("res.partner", 7, "A".repeat(250)) },
        { refRecord: makeRefResolver(REF_KEY) }
      );
      expect(result.summary.target).toEqual({
        ...recordRef("res.partner", 7, "A".repeat(200)),
        labelCut: 50,
      });
      expect(result.incomplete).toBe(false);
    });

    // Replacing every string that merely STARTS with the prefix would hide
    // free text — an email body that began with "pinchy_ref:v1:" would vanish
    // behind "(record reference)". Only a
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
      expect(out.target).toEqual(recordRef("account.move", 42, "INV/2026/0042"));
    });

    // Rendered by model alone — "record reference: account.move" — two
    // invoices would read identically, so approving one would approve a card
    // that could equally describe the other.
    it("tells two records of the same model apart", () => {
      const resolve = { refRecord: makeRefResolver(REF_KEY) };
      const a = summarizeArgs({ target: ref("account.move", 42, "INV/2026/0042") }, resolve);
      const b = summarizeArgs({ target: ref("account.move", 43, "INV/2026/0043") }, resolve);
      expect(a.target).not.toEqual(b.target);
      expect(b.target).toEqual(recordRef("account.move", 43, "INV/2026/0043"));
    });

    it("renders refs nested in arrays too", () => {
      const out = summarizeArgs(
        { targets: [ref("res.partner", 7, "Ada"), ref("res.partner", 8, "Bob")] },
        { refRecord: makeRefResolver(REF_KEY) }
      );
      expect(out.targets).toEqual([
        recordRef("res.partner", 7, "Ada"),
        recordRef("res.partner", 8, "Bob"),
      ]);
    });

    it("passes the label through the same escaping as any other text", () => {
      const out = summarizeArgs(
        { target: ref("account.move", 42, 'INV\u202E"x"   \n42') },
        { refRecord: makeRefResolver(REF_KEY) }
      );
      expect(JSON.stringify(out.target)).not.toContain("\u202E");
      expect(JSON.stringify(out.target)).toContain("⟨U+202E⟩");
      // Whitespace is not collapsed, so the three spaces and the line break
      // stay as sent.
      expect(out.target).toEqual(recordRef("account.move", 42, 'INV⟨U+202E⟩"x"   \n42'));
    });
  });

  // Node's base64url decoder stops at the first `=` and drops the rest, so
  // `<valid ref>=\n\n<any text>` still decodes. A card that trusted the decode
  // would show only "(record reference: …)" — and skip the length check —
  // while the tool received the whole string: an email body hiding a payment
  // instruction behind a ref. Only the exact string the encoder writes is a
  // ref; anything longer is text, shown and counted like any other.
  describe("a ref with anything after it is text", () => {
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
      );
      expect(textIn(out.body)).not.toContain("record reference");
      expect(textIn(out.body)).toContain("AT00 1234 5678 9012");
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
      const out = summarizeArgs({ body }, { refRecord: anything });
      expect(textIn(out.body)).toContain("AT00 1234 5678 9012");
      expect(textIn(out.body)).not.toContain("record reference");
    });

    it("counts the trailing text against the length limit", () => {
      const body = `${partner()}=${"a".repeat(200_001)}`;
      const result = summarizeCall({ body }, { refRecord: makeRefResolver(REF_KEY) });
      expect(result.incomplete).toBe(true);
      expect(result.exceeded).toMatchObject({ kind: "text-too-long", at: "body" });
    });
  });

  describe("keys are shown as they are, never merged", () => {
    // Trimmed to "to", a key "to " (trailing space) would merge over the real
    // `to`, so the card would show the boss while the tool — which reads `to` —
    // mailed the attacker.
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

  describe("invisible characters cannot smuggle a payload", () => {
    const tag = (text: string) =>
      [...text].map((c) => String.fromCodePoint(0xe0000 + c.codePointAt(0)!)).join("");

    // A run collapsed into one marker naming its first three characters would
    // lose the payload past them — and with it the difference between two
    // runs. Every one is named.
    it("makes Unicode tag characters visible, every one of them", () => {
      const payload = tag("send to evil@x.com");
      const out = summarizeArgs({ subject: `Report${payload}` }) as { subject: string };
      expect(out.subject).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
      expect(out.subject).toBe(
        `Report${[..."send to evil@x.com"]
          .map((c) => `⟨U+${(0xe0000 + c.codePointAt(0)!).toString(16).toUpperCase()}⟩`)
          .join("")}`
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

    // Whether the joiners and selectors inside an RGI emoji are drawn as a
    // single glyph depends on the approver's font, not on the server's Unicode data — Windows 10's
    // Segoe UI Emoji has no ❤️‍🔥, and draws it like ❤️🔥. So they are marked
    // inside an emoji too.
    it("marks the joiners and selectors of an emoji too", () => {
      const family = "👨‍👩‍👧";
      const heart = "❤️";
      const fire = "❤️‍\u{1F525}";
      const out = summarizeArgs({ subject: `${family} ${heart} ${fire}` }) as { subject: string };
      expect(out.subject).toBe("👨⟨U+200D⟩👩⟨U+200D⟩👧 ❤⟨U+FE0F⟩ ❤⟨U+FE0F⟩⟨U+200D⟩\u{1F525}");
    });

    it.each([
      ["❤️‍\u{1F525} Notizen.md", "❤️\u{1F525} Notizen.md"],
      ["\u{1F426}‍\u{1F525}.md", "\u{1F426}\u{1F525}.md"],
    ])("draws %s apart from %s, whatever the approver's font", (joined, apart) => {
      const shown = (path: string) => summarizeArgs({ path: `/data/${path}` }).path as string;
      expect(shown(joined)).toContain("⟨U+200D⟩");
      expect(shown(apart)).not.toContain("⟨U+200D⟩");
    });

    // ☺︎ (a text-presentation selector after ☺) is not an RGI emoji, and
    // Helvetica draws it exactly like ☺.
    it("marks a selector after a symbol", () => {
      expect(summarizeArgs({ subject: "☺︎" })).toEqual({ subject: "☺⟨U+FE0E⟩" });
    });

    // Kept raw, the joiner and the presentation selectors make "Noack‍ GmbH"
    // read as "Noack GmbH" — a different name to look up — and "RE-1001️" as
    // "RE-1001", which the
    // vendor-bill duplicate check compares exactly. Outside an emoji they
    // render as nothing, so they are marked like any other invisible character.
    it("marks a joiner or presentation selector that is not part of an emoji", () => {
      const out = summarizeArgs({
        model: "account.move",
        values: { partner_id: "Noack‍ GmbH", ref: "RE-1001️", note: "a︎b" },
      }) as { values: Record<string, string> };
      expect(out.values).toEqual({
        partner_id: "Noack⟨U+200D⟩ GmbH",
        ref: "RE-1001⟨U+FE0F⟩",
        note: "a⟨U+FE0E⟩b",
      });
    });

    // Keeping a joiner raw where RFC 5892's CONTEXTJ rule says it shapes
    // Arabic-script or Indic text, or any per-script narrowing of that, lets
    // through joiners that draw nothing in some font — `க்‌ம.md` reads as
    // `க்ம.md`. A joiner is marked, in every script.
    it("marks a joiner in Arabic-script and Indic text", () => {
      const text = "گزارش‌ها ශ්‍රී അവന്‍ क्‌ष";
      const shown = "گزارش⟨U+200C⟩ها ශ්⟨U+200D⟩රී അവന്⟨U+200D⟩ क्⟨U+200C⟩ष";
      expect(summarizeArgs({ subject: text, path: `/data/output/${text}.md` })).toEqual({
        path: `/data/output/${shown}.md`,
        subject: shown,
      });
    });

    it.each([
      ["a ZWNJ between Latin letters", "a‌b", "a⟨U+200C⟩b"],
      ["a ZWNJ after a right-joining letter", "محمد‌رضا", "محمد⟨U+200C⟩رضا"],
      ["a ZWJ between Arabic letters", "ش‍ه", "ش⟨U+200D⟩ه"],
      ["a ZWNJ after a virama at the end", "जगत्‌.md", "जगत्⟨U+200C⟩.md"],
      // The virama is Devanagari and draws on no Latin letter, so it is a
      // marker too.
      ["a ZWNJ after a virama on a Latin letter", "a्‌b.md", "a⟨U+094D⟩⟨U+200C⟩b.md"],
      // Mid-word, after a virama, before a letter of the same script.
      ["a ZWNJ inside a Tamil word", "க்‌ம", "க்⟨U+200C⟩ம"],
      ["a ZWJ inside a Tamil word", "க்‍ம", "க்⟨U+200D⟩ம"],
      ["a ZWJ inside a Thai word", "กฺ‍ม", "กฺ⟨U+200D⟩ม"],
      ["a ZWJ inside a Myanmar word", "က်‍မ", "က်⟨U+200D⟩မ"],
      ["a ZWJ inside a Sinhala word", "ක්‍ම", "ක්⟨U+200D⟩ම"],
      ["a ZWJ inside a Gurmukhi word", "ਕ੍‍ਮ", "ਕ੍⟨U+200D⟩ਮ"],
    ])("marks %s", (_label, text, shown) => {
      expect(summarizeArgs({ subject: text })).toEqual({ subject: shown });
    });

    it.each([
      ["a joiner trailing an emoji", "\u{1F468}‍.", "\u{1F468}⟨U+200D⟩."],
      ["a joiner before an emoji", "a‍\u{1F468}", "a⟨U+200D⟩\u{1F468}"],
      ["a second selector", "⚠️️", "⚠⟨U+FE0F⟩⟨U+FE0F⟩"],
      // Two pictographs joined by a ZWJ are not one emoji to every font, and
      // no joiner is shown raw at all.
      ["two pages joined", "\u{1F4C4}‍\u{1F4C4}", "\u{1F4C4}⟨U+200D⟩\u{1F4C4}"],
      ["a heart on fire without its selector", "❤‍\u{1F525}", "❤⟨U+200D⟩\u{1F525}"],
      [
        "a family joined to a page",
        "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F4C4}",
        "\u{1F468}⟨U+200D⟩\u{1F469}⟨U+200D⟩\u{1F467}⟨U+200D⟩\u{1F4C4}",
      ],
    ])("marks %s", (_label, text, shown) => {
      expect(summarizeArgs({ subject: text })).toEqual({ subject: shown });
    });

    it("applies the same escaping to keys", () => {
      const out = summarizeArgs({ [`to${tag("evil")}`]: "x" });
      const [label] = Object.keys(out);
      expect(label).not.toMatch(/[\u{E0000}-\u{E007F}]/u);
      expect(label).toContain("⟨U+E0065⟩⟨U+E0076⟩⟨U+E0069⟩⟨U+E006C⟩");
    });

    // Collapsing a run after its third character would make `a` + four
    // joiners and `a` + three joiners and a non-joiner — and two paths padded
    // with different space separators, which pinchy-files accepts — one card. Only a run of ONE repeated character is
    // counted; a mixed run names every character, in order.
    it.each([
      ["joiners", "a\u200D\u200D\u200D\u200D", "a\u200D\u200D\u200D\u200C"],
      [
        "joiners, differing early",
        "a\u200C\u200D\u200D\u200D\u200D",
        "a\u200D\u200C\u200D\u200D\u200D",
      ],
      [
        "space separators",
        "/data/x\u00A0\u2000\u2001\u2002.md",
        "/data/x\u00A0\u2000\u2001\u2003.md",
      ],
      ["a long run", `x${"\u2800".repeat(90)}`, `x${"\u2800".repeat(89)}\u2801`],
    ])("tells two runs of %s apart", (_label, a, b) => {
      for (const key of ["subject", "path"]) {
        expect(summarizeArgs({ [key]: a })[key]).not.toBe(summarizeArgs({ [key]: b })[key]);
      }
      expect(Object.keys(summarizeArgs({ [a]: 1 }))[0]).not.toBe(
        Object.keys(summarizeArgs({ [b]: 1 }))[0]
      );
    });

    it("counts a run of one character, and names each character of a mixed run", () => {
      expect(summarizeArgs({ subject: "a\u200D\u200D\u200D\u200D\u200Cb" })).toEqual({
        subject: "a⟨4 × U+200D⟩⟨U+200C⟩b",
      });
      expect(summarizeArgs({ subject: "a\u200D\u200D\u200D\u200Cb" })).toEqual({
        subject: "a⟨U+200D⟩⟨U+200D⟩⟨U+200D⟩⟨U+200C⟩b",
      });
    });

    // The rule the pairs above are instances of: two different texts never
    // share a summary, whatever runs of invisible characters they hold.
    it("gives every different run of invisible characters its own rendering", () => {
      const alphabet = ["\u200D", "\u200C", "\u00A0", "\u2000", "\u2800", "\u{E0041}", " ", "a"];
      let seed = 14;
      const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      for (const key of ["subject", "path"]) {
        const seen = new Map<string, string>();
        for (let n = 0; n < 3000; n++) {
          const length = 1 + Math.floor(random() * 14);
          const text = Array.from(
            { length },
            () => alphabet[Math.floor(random() * alphabet.length)]
          ).join("");
          const shown = summarizeArgs({ [key]: text })[key] as string;
          const earlier = seen.get(shown);
          if (earlier !== undefined && earlier !== text) {
            expect.fail(
              `${JSON.stringify(earlier)} and ${JSON.stringify(text)} both read ${shown}`
            );
          }
          seen.set(shown, text);
        }
      }
    });
  });

  // A value that TYPED a marker would render exactly like the character the
  // marker stands for — `/data/a⟨U+200D⟩b.md` sent as text and `/data/a‍b.md`
  // with a real joiner would be one card, and pinchy-files
  // accepts both. So the brackets themselves are marked: every `⟨` on the
  // card opens a marker the summary wrote.
  describe("a typed marker never reads as a real one", () => {
    it.each([
      ["a joiner", "/data/a⟨U+200D⟩b.md", "/data/a‍b.md"],
      ["a no-break space", "/data/x⟨U+00A0⟩y.md", "/data/x y.md"],
      ["a run of spaces", "/data/a⟨4 spaces⟩b.md", "/data/a    b.md"],
    ])("shows a typed marker for %s apart from the character", (_label, typed, real) => {
      const shown = (path: string) => summarizeArgs({ path }).path as string;
      expect(shown(typed)).not.toBe(shown(real));
    });

    it("marks the brackets of a typed marker", () => {
      expect(summarizeArgs({ path: "/data/a⟨U+200D⟩b.md" })).toEqual({
        path: "/data/a⟨U+27E8⟩U+200D⟨U+27E9⟩b.md",
      });
    });

    it("marks a bracket next to an invisible character, each on its own", () => {
      expect(summarizeArgs({ subject: "‍⟨‍⟩" })).toEqual({
        subject: "⟨U+200D⟩⟨U+27E8⟩⟨U+200D⟩⟨U+27E9⟩",
      });
    });

    it("marks a typed marker in a record label and a display name too", () => {
      const ref = encodeRef({
        integrationType: "odoo",
        connectionId: "c1",
        model: "res.partner",
        id: 7,
        label: "Noack⟨U+200D⟩ GmbH",
      });
      const out = summarizeArgs(
        { target: ref, to: '"Noack⟨U+200D⟩" <a@x.at>' },
        { refRecord: makeRefResolver(REF_KEY) }
      );
      expect(out).toEqual({
        target: recordRef("res.partner", 7, "Noack⟨U+27E8⟩U+200D⟨U+27E9⟩ GmbH"),
        to: named("a@x.at", "Noack⟨U+27E8⟩U+200D⟨U+27E9⟩"),
      });
    });

    // The drift guard: whatever a value holds, every `⟨` in its rendering
    // opens one of the markers the summary writes, and every `⟩` closes one.
    it("never lets a bracket stand outside a marker it wrote", () => {
      const MARKER =
        /⟨(?:U\+[0-9A-F]{4,6}|\d+ (?:spaces|line breaks|tabs)|\d+ × U\+[0-9A-F]{4,6})⟩/gu;
      const alphabet = ["⟨", "⟩", "U", "+", "2", "0", "D", " ", "\n", "\t", "‍", " ", "a"];
      let seed = 1242;
      const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const stray: string[] = [];
      for (let n = 0; n < 2000; n++) {
        const length = 1 + Math.floor(random() * 12);
        const text = Array.from(
          { length },
          () => alphabet[Math.floor(random() * alphabet.length)]
        ).join("");
        for (const shown of [
          summarizeArgs({ subject: text }).subject as string,
          summarizeArgs({ path: text }).path as string,
          Object.keys(summarizeArgs({ [text]: 1 }))[0],
        ]) {
          if (/[⟨⟩]/u.test(shown.replace(MARKER, ""))) stray.push(JSON.stringify(text));
        }
      }
      expect(stray).toEqual([]);
    });
  });

  // A combining mark draws on the glyph in front
  // of it. With no letter there — at the start, after a space, a `/`,
  // punctuation or a marker — or with a letter of another script there, it
  // was drawn onto the neighbouring word, exactly like the same mark on that
  // word's letter: `\u05BCבא` and `בא\u05BC` were pixel-identical in Chromium
  // and WebKit, `a\u05BCع` and `aع\u05BC` in Chromium. Such a mark is shown as
  // a marker; a mark on a letter of its own script (or on a mark that sits on
  // one) stays as it is.
  describe("a combining mark with no letter to sit on", () => {
    const shown = (path: string) => summarizeArgs({ path }).path as string;

    it.each([
      ["a dagesh before a word and on its last letter", "\u05BCבא", "בא\u05BC"],
      ["a dagesh alone and on a letter", "\u05BCא", "א\u05BC"],
      ["a dagesh on either side of a maqaf", "\u05BE\u05BC/", "\u05BC\u05BE/"],
      ["a fatha before an Arabic word and on its last letter", "\u064Eعب", "عب\u064E"],
    ])("shows %s apart", (_label, a, b) => {
      // The glyphs left to right, as the card draws them: pieces in stored
      // order, each right-to-left word reversed. A mark lands next to whatever
      // glyph it ends up beside — which, for both texts, was the same one.
      const drawn = (text: string) =>
        (inStoredOrder(text) ?? [[{ text, word: false }]])
          .map((line) =>
            line.map((p) => (p.word ? [...p.text].reverse().join("") : p.text)).join("")
          )
          .join("\n");
      expect(drawn(a)).toBe(drawn(b));
      expect(drawn(shown(a))).not.toBe(drawn(shown(b)));
    });

    it.each([
      ["at the start", "\u05BCבא", "⟨U+05BC⟩בא"],
      ["after a slash", "/data/\u05BCבא.md", "/data/⟨U+05BC⟩בא.md"],
      ["after a space", "a \u0301b", "a ⟨U+0301⟩b"],
      ["after a maqaf", "\u05BE\u05BC/", "\u05BE⟨U+05BC⟩/"],
      ["after a digit", "1\u05BC", "1⟨U+05BC⟩"],
      ["after punctuation", "a.\u0301", "a.⟨U+0301⟩"],
      ["after a marker", "a\u200D\u0301", "a⟨U+200D⟩⟨U+0301⟩"],
      ["after a marker bracket", "⟨\u0301", "⟨U+27E8⟩⟨U+0301⟩"],
      ["after a run of spaces", "a    \u0301", "a⟨4 spaces⟩⟨U+0301⟩"],
      ["after a line break", "a\n\u064E", "a\n⟨U+064E⟩"],
      ["two of them", "\u0301\u0301", "⟨U+0301⟩⟨U+0301⟩"],
      ["a keycap after its selector", "1\uFE0F\u20E3", "1⟨U+FE0F⟩⟨U+20E3⟩"],
      ["a keycap on a bare digit", "1\u20E3", "1⟨U+20E3⟩"],
      ["on a letter of another script", "a\u05BCع", "a⟨U+05BC⟩ع"],
      ["of Arabic on a Hebrew letter", "א\u064E", "א⟨U+064E⟩"],
      ["of Devanagari on a Latin letter", "a\u093F", "a⟨U+093F⟩"],
      ["of Latin on a modifier letter of no script", "ʹ\u0301", "ʹ⟨U+0301⟩"],
      ["after another script's mark on a letter", "a\u05BC\u0301", "a⟨U+05BC⟩⟨U+0301⟩"],
    ])("marks one %s", (_label, text, expected) => {
      expect(shown(text)).toBe(expected);
    });

    it.each([
      ["Hebrew with niqqud", "/data/שָׁלוֹם.md"],
      ["a Hebrew letter with dagesh, shin dot and vowel", "שּׁוּק"],
      ["Arabic with harakat", "مَرْحَبًا"],
      ["harakat on a tatweel", "ـَ"],
      ["Devanagari vowel signs and a virama", "नमस्ते हिंदी"],
      ["Thai vowel and tone marks", "น้ำใจ ภาษาไทย"],
      ["Tamil vowel signs and a pulli", "தமிழ் கோப்பு"],
      ["Latin letters with NFD accents", "Cafe\u0301 Zu\u0308rich"],
      ["a Latin letter with two stacked accents", "e\u0323\u0302"],
      ["Cyrillic with a stress accent", "мо\u0301ре"],
      ["a Japanese voicing mark", "か\u3099"],
      ["a strike-through, a mark of every script, on any letter", "א\u0336ب\u0336a\u0336"],
    ])("keeps %s as it is", (_label, text) => {
      expect(shown(text)).toBe(text);
    });

    it("marks it in a display name, and in a key", () => {
      expect(summarizeArgs({ to: '"\u0301Ada" <ada@example.com>' }).to).toEqual(
        named("ada@example.com", "⟨U+0301⟩Ada")
      );
      expect(Object.keys(summarizeArgs({ ["\u05BCא"]: 1 }))).toEqual(['"⟨U+05BC⟩⟨U+05D0⟩"']);
    });

    // The drift guard: whatever a value holds, every combining mark left raw
    // in its rendering sits on a letter it is written with, directly or
    // through other marks; any other mark is a marker. And none is lost.
    it("never leaves a mark raw without a letter of its own under it", () => {
      const alphabet = [
        "\u05BC",
        "\u064E",
        "\u0301",
        "\u0336",
        "\u20E3",
        "\u093F",
        "א",
        "ب",
        "a",
        "क",
        "1",
        "/",
        " ",
        "\n",
        "\u05BE",
        "'",
        "\u200D",
        "\uFE0F",
        "⟨",
        "\u00A0",
      ];
      // Which letters each mark of the alphabet may stay raw on, by hand.
      const ownLetters: Record<string, RegExp> = {
        "\u05BC": /\p{scx=Hebr}/u,
        "\u064E": /\p{scx=Arab}/u,
        "\u093F": /\p{scx=Deva}/u,
        "\u0301": /\p{scx=Latn}|\p{scx=Cyrl}|\p{scx=Grek}/u,
        "\u0336": /\p{L}/u,
        "\u20E3": /\p{L}/u,
      };
      let seed = 1242;
      const random = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
      const MARK = /\p{M}/u;
      const bad: string[] = [];
      for (let n = 0; n < 3000; n++) {
        const length = 1 + Math.floor(random() * 10);
        const text = Array.from(
          { length },
          () => alphabet[Math.floor(random() * alphabet.length)]
        ).join("");
        const out = [...shown(text)];
        out.forEach((char, i) => {
          if (!MARK.test(char)) return;
          let j = i - 1;
          while (j >= 0 && MARK.test(out[j])) j--;
          if (j < 0 || !out.slice(j + 1, i + 1).every((m) => ownLetters[m].test(out[j]))) {
            bad.push(JSON.stringify(text));
          }
        });
        // Every mark of the text, in order, either raw or as its marker (the
        // presentation selector is a hidden character, marked as one).
        const visibleMark = (c: string) => MARK.test(c) && c !== "\uFE0F";
        const sent = [...text].filter(visibleMark);
        const kept = [...shown(text).matchAll(/⟨U\+([0-9A-F]{4,6})⟩|\p{M}/gu)]
          .map((m) => (m[1] ? String.fromCodePoint(parseInt(m[1], 16)) : m[0]))
          .filter(visibleMark);
        if (kept.join() !== sent.join()) bad.push(`lost: ${JSON.stringify(text)}`);
      }
      expect([...new Set(bad)]).toEqual([]);
    });

    // The scripts a mark may sit on are listed by name. A mark of a script
    // the list lacks would never be kept — safe, but Hindi or Hebrew would
    // read as a row of markers — so every mark that is not of every script
    // must belong to a listed one.
    it("knows the script of every mark that is not of every script", () => {
      const unlisted: string[] = [];
      const used = new Set<string>();
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        const char = String.fromCodePoint(cp);
        if (!/\p{M}/u.test(char) || /\p{scx=Zinh}/u.test(char)) continue;
        // Common-script marks (musical symbols) sit on no letter: marked.
        if (/\p{scx=Zyyy}/u.test(char)) continue;
        const scripts = markScripts(char);
        if (scripts.length === 0) unlisted.push(cp.toString(16));
        for (const name of scripts) used.add(name);
      }
      expect(unlisted).toEqual([]);
      expect(used.size).toBeGreaterThan(100);
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

    // Filler keys before `to` must not eat the size budget, cutting the
    // recipient or pushing it past MAX_KEYS altogether.
    // The budget is 512,000, so the filler grows past it to exhaust it.
    it("renders recipients in full even behind filler that exhausts the budget", () => {
      const filler = Object.fromEntries(
        Array.from({ length: 40 }, (_, i) => [`f${String(i).padStart(2, "0")}`, "z".repeat(15_000)])
      );
      const out = summarizeArgs({ ...filler, to: "attacker@evil.com", cc: "x@evil.com" });
      expect(out.to).toBe("attacker@evil.com");
      expect(out.cc).toBe("x@evil.com");
      expect(JSON.stringify(out)).toMatch(/not shown/);
    });

    // MAX_KEYS is 100, so the filler grows past it to test what the name says.
    it("renders recipients even behind more than the maximum number of keys", () => {
      const filler = Object.fromEntries(Array.from({ length: 160 }, (_, i) => [`k${i}`, i]));
      const out = summarizeArgs({ ...filler, bcc: "hidden@evil.com", reply_to: "r@evil.com" });
      expect(out.bcc).toBe("hidden@evil.com");
      expect(out.reply_to).toBe("r@evil.com");
    });

    // The total budget is 512,000, so the summary may be large — but against
    // 12.5 million characters of keys sent, it still stays within the budget's
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
      expect(out.to).toEqual(hosted(`boss@${domain}`, domainToASCII(domain)));
      expect(JSON.stringify(out.to)).toMatch(/xn--/);
    });

    it("does the same inside a named address and per entry of a list", () => {
      const domain = "f\u0456rma.at";
      const out = summarizeArgs({ cc: `Boss <boss@${domain}>, ok@firma.at` });
      expect(out.cc).toEqual([
        {
          "@": "noted",
          text: `boss@${domain}`,
          notes: [
            { kind: "host", host: domainToASCII(domain) },
            { kind: "name", name: "Boss" },
          ],
        },
        "ok@firma.at",
      ]);
    });

    it("leaves an ASCII domain alone", () => {
      expect(summarizeArgs({ to: "boss@firma.at" }).to).toBe("boss@firma.at");
    });
  });

  // A label that starts `xn--` and does not decode — `xn--a` — is no domain
  // name: Node refuses it, so there is no resolved form to name. The text as
  // written is what reaches the mail library or the browser, so that is what
  // the call is said to reach, and the card says the domain does not parse.
  // An ASCII one included: `boss@xn--a.evil.com` reads as a plain domain.
  describe("hosts that are not a valid domain name", () => {
    const notADomain = (text: string, host: string) => ({
      "@": "noted",
      text,
      notes: [{ kind: "not-a-domain", host }],
    });

    it("notes a mailbox's domain and records it, as written, as reached", () => {
      for (const key of ["to", "email"]) {
        const { summary, hosts } = summarizeCall({ [key]: "Boss@XN--A.Evil.com" });
        expect(summary[key]).toEqual(notADomain("Boss@XN--A.Evil.com", "xn--a.evil.com"));
        expect(hosts).toEqual(["xn--a.evil.com"]);
      }
    });

    // An address that ends at its `@` names no domain at all: nothing is
    // reached, and the card can still read every node the summary writes.
    it.each([
      ["a bare recipient", { to: "boss@" }],
      ["a named recipient", { to: "Boss <boss@>" }],
      ["a nested `to`", { values: { to: "meet @" } }],
    ])("writes no domain note for %s with an empty domain", (_label, args) => {
      const { summary, hosts, exceeded } = summarizeCall(args);
      expect(exceeded).toBeNull();
      expect(hosts).toEqual([]);
      expect(JSON.stringify(summary)).not.toContain("not-a-domain");
      for (const value of Object.values(summary)) expect(readNode(value)).not.toBe("unreadable");
    });

    it("notes a URL whose host the parser refuses, and records that host as reached", () => {
      const url = "https://user@XN--A.Evil.com:8080/x";
      const { summary, hosts } = summarizeCall({ website: url });
      expect(summary.website).toEqual(notADomain(url, "xn--a.evil.com"));
      expect(hosts).toEqual(["xn--a.evil.com"]);
    });

    // The parser deletes a tab or line break anywhere and takes a space in the
    // path, query or fragment, so Chromium and WebKit open each of these at
    // xn--a.evil.com. What follows the host does not change where it goes.
    it.each([
      ["a tab in the path", "https://xn--a.evil.com/x\ty"],
      ["a space in the path", "https://xn--a.evil.com/x y"],
      ["a no-break space in the path", "https://xn--a.evil.com/x\u00a0y"],
      ["a tab in the host", "https://xn--a.ev\til.com/"],
      ["a tab in the scheme", "ht\ttps://xn--a.evil.com/"],
      ["words after it", "https://xn--a.evil.com/ see above"],
      ["a long user name in front", `https://www.firma.at.${"a".repeat(250)}@xn--a.evil.com/\tx`],
    ])("notes such a URL with %s, and records its host as reached", (_shape, url) => {
      const { summary, hosts } = summarizeCall({ values: { website: url } });
      expect((summary.values as Record<string, unknown>).website).toMatchObject({
        "@": "noted",
        notes: [{ kind: "not-a-domain", host: "xn--a.evil.com" }],
      });
      expect(hosts).toEqual(["xn--a.evil.com"]);
    });

    it("shows any hidden character in such a host as the marker the card shows", () => {
      const { summary, hosts } = summarizeCall({ to: "boss@xn--a.evil​.com" });
      expect(hosts).toEqual(["xn--a.evil⟨U+200B⟩.com"]);
      expect(summary.to).toMatchObject({
        notes: [{ kind: "not-a-domain", host: "xn--a.evil⟨U+200B⟩.com" }],
      });
    });

    it("leaves free text that only starts with such a URL alone", () => {
      const { summary, hosts } = summarizeCall({ note: "https://xn--a.evil.com see above" });
      expect(summary.note).toBe("https://xn--a.evil.com see above");
      expect(hosts).toEqual([]);
    });
  });

  describe("recipient display", () => {
    // The probe: a familiar display name padded with braille blanks would push
    // the real address out of the card's preview. The address comes first.
    it("puts the address first and the display name after it", () => {
      const to = `Raimund Korber${"\u2800".repeat(190)} <attacker@evil.com>`;
      const out = summarizeArgs({ to, subject: "Rechnung", body: "Hallo" });
      expect(out.to).toEqual(named("attacker@evil.com", "Raimund Korber⟨190 × U+2800⟩"));
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

  // A target names one file or record, and two names
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
      ["a check mark", "/data/out/Vertrag ✅️.pdf", "/data/out/Vertrag ✅⟨U+FE0F⟩.pdf"],
      ["a page", "/data/out/\u{1F4C4}️.md", "/data/out/\u{1F4C4}⟨U+FE0F⟩.md"],
      // Helvetica draws it exactly like ✅.
      [
        "a check mark asked to be text",
        "/data/out/Vertrag ✅︎.pdf",
        "/data/out/Vertrag ✅⟨U+FE0E⟩.pdf",
      ],
    ])("marks a presentation selector that changes nothing after %s", (_label, path, shown) => {
      expect(summarizeArgs({ path })).toEqual({ path: shown });
    });

    it.each([
      ["a warning sign shown as emoji", "/data/notes/⚠️ offen.md"],
      ["a joined family", "/data/notes/\u{1F468}‍\u{1F469}‍\u{1F467} Familie.md"],
      ["a rainbow flag", "/data/notes/\u{1F3F3}️‍\u{1F308} Pride.md"],
      ["a keycap", "/data/notes/1️⃣ first.md"],
      ["a skin-toned technologist", "/data/notes/\u{1F469}\u{1F3FD}‍\u{1F4BB} Dev.md"],
      ["a heart on fire", "/data/notes/❤️‍\u{1F525} Team.md"],
    ])("marks the format characters of %s, which the approver's font may not join", (_l, path) => {
      // …and the keycap's U+20E3, which follows the marked U+FE0F and so has
      // no letter to sit on.
      const marked = path.replace(
        /[\u200D\uFE0F\u20E3]/g,
        (char) => `⟨U+${char.codePointAt(0)!.toString(16).toUpperCase()}⟩`
      );
      expect(marked).not.toBe(path);
      expect(summarizeArgs({ path })).toEqual({ path: marked });
    });
  });
  // A marker that says "N more fields not shown" is
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
      expect(plain(summary)).toEqual(params);
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
      // Probe sized to the limit of 200,000 characters.
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

    // Four long strings use up the budget, and the field after them — the bank
    // account the invoice is paid to — becomes "1 more field not shown". It is
    // never silently dropped and approved.
    // Probe sized to the budget of 512,000 characters.
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

  // The punycode form is not only for recipients: an Odoo `values.email` or
  // `website` with a Cyrillic "і" reads exactly like the real domain.
  describe("homoglyph hosts anywhere in the call", () => {
    const domain = "f\u0456rma.at"; // Cyrillic і
    const ascii = domainToASCII(domain);

    it("names the punycode form beside an email-shaped value at any key and depth", () => {
      const out = summarizeArgs({
        model: "res.partner",
        ids: [7],
        values: { email: `billing@${domain}`, website: `https://${domain}/pay` },
      }) as { values: Record<string, unknown> };
      expect(out.values.email).toEqual(hosted(`billing@${domain}`, ascii));
      expect(out.values.website).toEqual(hosted(`https://${domain}/pay`, ascii));
    });

    it("does so inside arrays, and for a URL with credentials and a port", () => {
      const out = summarizeArgs({ links: [`http://user@${domain}:8080/x`] }) as {
        links: unknown[];
      };
      expect(out.links[0]).toEqual(hosted(`http://user@${domain}:8080/x`, ascii));
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

  // A cut between the two halves of an emoji, or a lone surrogate in the
  // input kept as it is, would be rejected by Postgres in jsonb ("Unicode low
  // surrogate must follow a high surrogate"), so the row could not be stored.
  describe("surrogates", () => {
    const LONE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

    // One string can't reach the budget, so a filler field spends most of it
    // first; with and without
    // a leading "a", one of the two cuts lands on a pair boundary.
    it("never cuts a string between the halves of an emoji", () => {
      for (const lead of ["", "a"]) {
        const out = summarizeArgs({
          a: "z".repeat(199_000),
          body: `${lead}${"😀".repeat(199_000)}`,
        });
        expect(textIn(out.body)).toMatch(/not shown\]$/);
        expect(LONE.test(textIn(out.body))).toBe(false);
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

  // A Windows line break shown as "⟨U+000D⟩" followed by a break would be
  // noise on every mail body written with CRLF.
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

  // A per-string limit of 20,000 characters of the ESCAPED text meant a gated
  // pinchy_write of a 25 KB report, or a mail body with no-break spaces (each
  // shown as an 8-character marker), could never be confirmed — and "split it
  // into smaller calls" is advice nobody can follow for one file or one mail.
  describe("long texts", () => {
    it("lets a gated pinchy_write of a 30,000-character report through, stored whole", () => {
      const content = "Quarterly report line.\n".repeat(1_305).slice(0, 30_000);
      const { summary, incomplete, exceeded } = summarizeCall({
        path: "/data/out/report.md",
        content,
      });
      expect(incomplete).toBe(false);
      expect(exceeded).toBeNull();
      expect(textIn(summary.content)).toBe(content);
    });

    it("measures a text by its own length, not by the markers it is shown with", () => {
      // 18,000 characters, one in eight a no-break space: shown, each NBSP is an
      // eight-character marker, so the rendered text is far past 20,000.
      const body = "Preis € ".repeat(2_250);
      expect([...body].length).toBe(18_000);
      const { summary, incomplete } = summarizeCall({ to: "a@b.at", subject: "s", body });
      expect(incomplete).toBe(false);
      expect(textIn(summary.body)).toBe(body.replaceAll(" ", "⟨U+00A0⟩"));
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
      // Plain letters first, so the preview the card draws is not emoji: an
      // emoji costs that card ASTRAL_COST to draw (`DRAW_BUDGET`).
      const body = (emoji: number) => "x".repeat(200) + "😀".repeat(emoji);
      expect(summarizeCall({ body: body(199_800) }).incomplete).toBe(false);
      expect(summarizeCall({ body: body(199_801) }).exceeded).toMatchObject({
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

  // When numbers, booleans, null and empty containers cost nothing,
  // 200×200×50 numbers produced a 5.7 MB summary.
  describe("every value counts against the total", () => {
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

    it("still shows a 200×30 grid of numbers in full", () => {
      const rows = grid(1, 200, 30)[0];
      const { summary, incomplete } = summarizeCall({ rows });
      expect(incomplete).toBe(false);
      expect(summary.rows).toEqual(rows);
    });

    it("refuses a 200×200 grid of numbers, whose 40,000 values are too costly to draw", () => {
      const { exceeded } = summarizeCall({ rows: grid(1, 200, 200)[0] });
      expect(exceeded).toEqual({
        kind: "too-costly-to-draw",
        // Each row 0…199: ten numbers of one digit, ninety of two, a hundred of three.
        cost: 1 + 4 + 200 * (10 * 2 + 90 * 3 + 100 * 4),
        limit: DRAW_BUDGET,
      });
    });
  });

  // What the collapsed card draws costs the approver's browser layout time,
  // and what one character costs varies by orders of magnitude: sixty
  // 4,096-character targets of alternating Hebrew letters and digits took about
  // a second, and so did 500 previews of emoji-flag sequences — both within
  // every other bound, in the approver's tab, for a call the gate accepted. So
  // a call whose card would cost more than DRAW_BUDGET to draw is refused,
  // like any other call the card cannot show.
  describe("a card that takes too long to draw", () => {
    const alternating = (length: number) =>
      Array.from({ length }, (_, i) => (i % 2 ? "1" : "א")).join("");
    /** `count` values under keys of their own, 200 to a list. */
    const lists = (count: number, value: () => unknown) =>
      Object.fromEntries(
        Array.from({ length: Math.ceil(count / 200) }, (_, k) => [
          `n${k}`,
          Array.from({ length: Math.min(200, count - k * 200) }, value),
        ])
      );

    it("refuses sixty long targets drawn whole", () => {
      const { exceeded } = summarizeCall({
        targets: Array.from({ length: 60 }, () => alternating(4_096)),
      });
      expect(exceeded).toEqual({
        kind: "too-costly-to-draw",
        // The key and each value: one for the element, one per character.
        cost: 1 + 7 + 60 * (1 + 4_096),
        limit: DRAW_BUDGET,
      });
    });

    it("refuses as many right-to-left words in short values, which are drawn whole too", () => {
      const notes = lists(2_000, () => alternating(200));
      expect(summarizeCall(notes).exceeded).toMatchObject({ kind: "too-costly-to-draw" });
    });

    it("refuses previews of emoji-flag sequences that fit every other bound", () => {
      // 🏳️‍🌈 in a family sequence: the white flag U+1F3F3 sends Chromium
      // through its font fallback once per run.
      const flags = "👩‍👩‍👧‍👦🏳️‍🌈".repeat(20).slice(0, 200);
      const { exceeded } = summarizeCall(lists(500, () => flags));
      expect(exceeded).toMatchObject({ kind: "too-costly-to-draw" });
    });

    it("charges a character outside the Basic Multilingual Plane ASTRAL_COST", () => {
      const cost = (text: string) =>
        (summarizeCall({ targets: [text] }).exceeded as { cost: number } | null)?.cost;
      // Under the bound, nothing is reported; one past it, the cost is exact.
      const flags = Math.floor((DRAW_BUDGET - 8 - 1) / ASTRAL_COST);
      expect(cost("🏳".repeat(flags))).toBeUndefined();
      expect(cost("🏳".repeat(flags + 1))).toBe(8 + 1 + (flags + 1) * ASTRAL_COST);
    });

    // Bold or italic letters from the Mathematical Alphanumeric Symbols block
    // (𝐁𝐢𝐠 𝐧𝐞𝐰𝐬) are how a post drafted for LinkedIn sets a heading. They lie
    // outside the Basic Multilingual Plane, yet both engines lay them out like
    // Latin letters, cold and warm: the cost of a character outside it sits
    // in emoji, flags and the fonts loaded on first use (`ASTRAL_COST`).
    it("charges a mathematical letter like a letter, so a styled post is not refused", () => {
      const bold = (text: string) =>
        [...text]
          .map((c) => (/[a-z]/.test(c) ? String.fromCodePoint(0x1d41a + c.charCodeAt(0) - 97) : c))
          .join("");
      const post = `${bold("big news for our whole team ").repeat(12)}\n\nWe are hiring.`;
      expect(drawCost(bold("abc"))).toBe(1 + 3);
      expect(summarizeCall({ body: post }).exceeded).toBeNull();
      expect(summarizeCall({ targets: ["\u{1D400}".repeat(8_000)] }).exceeded).toBeNull();
    });

    it("counts a previewed text by its preview, however long the text", () => {
      // 80 texts of 6,000 characters, 200 drawn of each.
      const { exceeded } = summarizeCall({
        notes: Array.from({ length: 80 }, () => "x".repeat(6_000)),
      });
      expect(exceeded).toBeNull();
    });

    // The summary stores where the card cuts each preview (`Previewed`), and
    // charges exactly what that cut draws: the card decides nothing of its
    // own, so no browser's segmenter or URL parser can draw more.
    describe("charges exactly what the card draws", () => {
      /** A stream of numbers in [0, 1) from `seed`, the same on every run (mulberry32). */
      function seeded(seed: number): () => number {
        return () => {
          seed = (seed + 0x6d2b79f5) | 0;
          let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
          t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
          return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
      }

      /**
       * Pieces that make one long character as read: an emoji and its skin
       * tones, an accent stack on a non-ASCII letter, a flag, Malayalam dot
       * rephs (they prepend to what follows), Hangul jamo, a Devanagari
       * conjunct.
       */
      const PIECES = ["é", "👍", "🏽", "́", "🇦🇹", "ൎ", "ᄀ", "ᅡ", "ᆨ", "क्", "ष", "x"];

      function hostile(next: () => number): string {
        const length = 150 + Math.floor(next() * 300);
        let text = PIECES[Math.floor(next() * 2)];
        while ([...text].length < length) {
          text += PIECES[Math.floor(next() * PIECES.length)].repeat(1 + Math.floor(next() * 60));
        }
        return text;
      }

      /**
       * What the summary charges for drawing `params`: two padding targets push
       * the call past the bound, so the refusal reports the cost.
       */
      function charged(params: Record<string, unknown>): number {
        const pad = "a".repeat(WHOLE_MAX);
        const { exceeded } = summarizeCall({ targets: [pad, pad], ...params });
        expect(exceeded).toMatchObject({ kind: "too-costly-to-draw" });
        return (exceeded as { cost: number }).cost - (1 + 7) - 2 * (1 + WHOLE_MAX);
      }

      it("charges a value what the card draws of it, as the summary stored it", () => {
        const values = ["é👍" + "🏽".repeat(250)];
        const next = seeded(1_242_021);
        for (let round = 0; round < 300; round++) values.push(hostile(next));
        let previews = 0;
        for (const value of values) {
          const shown = readShown(summarizeCall({ note: value }).summary.note);
          expect(shown).not.toBeNull();
          expect(drawCost(drawnOf(shown!))).toBe(charged({ note: value }) - (1 + 4));
          if (typeof shown !== "string") previews++;
        }
        expect(previews).toBeGreaterThan(250);
      });

      // One character as read, longer than the preview: its preview is the
      // letter in front of it, in every browser, so fifty of them draw cheaply.
      it("previews an emoji under hundreds of skin tones as the letter before it", () => {
        const value = "é👍" + "🏽".repeat(250);
        const params = {
          model: "res.partner",
          values: Object.fromEntries(
            Array.from({ length: 5 }, (_, k) => [`f${k}`, Array.from({ length: 10 }, () => value)])
          ),
        };
        const { exceeded, summary } = summarizeCall(params);
        expect(exceeded).toBeNull();
        const drawn = Object.values(summary.values as Record<string, unknown[]>)
          .flat()
          .map((shown) => drawnOf(readShown(shown)!));
        expect(new Set(drawn)).toEqual(new Set(["é"]));
      });
    });

    it("counts every value drawn, a number or a one-letter text too", () => {
      const count = Math.ceil(DRAW_BUDGET / 2);
      expect(summarizeCall(lists(count, () => 7)).exceeded).toMatchObject({
        kind: "too-costly-to-draw",
      });
      expect(summarizeCall(lists(count, () => "x")).exceeded).toMatchObject({
        kind: "too-costly-to-draw",
      });
    });

    it("still shows one target as long as a target may be drawn whole", () => {
      const { incomplete } = summarizeCall({ targets: [alternating(WHOLE_MAX)] });
      expect(incomplete).toBe(false);
    });

    it("still shows an ordinary Hebrew record write in full", () => {
      const line = "חברה בע״מ, רחוב הרצל 12, תל אביב — חשבונית לחודש מרץ";
      const values = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`x_${i}`, line]));
      expect(summarizeCall({ model: "res.partner", ids: [7], values }).incomplete).toBe(false);
    });

    it.each<[string, Record<string, unknown>]>([
      [
        "a mail with a long body",
        {
          to: "Anna Huber <anna.huber@firma.at>",
          cc: "team@firma.at",
          subject: "Angebot für März 🎉",
          body: "Sehr geehrte Frau Huber 🙂\n\n" + "Wir danken für Ihre Anfrage. ".repeat(5_000),
        },
      ],
      [
        "one address as long as a target is drawn whole, and sixty fields beside it",
        {
          url: `https://example.com/${"a/b".repeat(2_700)}`,
          body: "x".repeat(50_000),
          ...Object.fromEntries(
            Array.from({ length: 60 }, (_, i) => [
              `x_field_${i}`,
              `Wert ${i}, etwas länger formuliert`,
            ])
          ),
        },
      ],
      [
        "an invoice with fifty lines",
        {
          model: "account.move",
          values: {
            partner_id: 7,
            invoice_line_ids: Array.from({ length: 50 }, (_, i) => [
              0,
              0,
              {
                product_id: i,
                name: `Beratung März, Position ${i}`,
                quantity: 10,
                price_unit: 120,
                tax_ids: [[6, 0, [1]]],
              },
            ]),
          },
        },
      ],
      [
        "a mail to two hundred named recipients",
        {
          to: Array.from({ length: 200 }, (_, i) => `Person ${i} <p${i}@firma.at>`).join(", "),
          subject: "Rundschreiben",
          body: "Hallo",
        },
      ],
      [
        "forty chat messages with emoji in them",
        {
          messages: Array.from({ length: 40 }, (_, i) => `Danke für Update ${i} 👍 — passt so 🎉`),
        },
      ],
    ])("still shows %s in full", (_name, params) => {
      expect(summarizeCall(params).exceeded).toBeNull();
    });
  });

  describe("what the refusal says", () => {
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
      const costly = describeRefusal({ kind: "too-costly-to-draw", cost: 245_828, limit: 16_384 });
      expect(costly).toMatch(split);
      expect(costly).toMatch(/245,828/);
      expect(costly).toMatch(/16,384/);
      expect(costly).toMatch(/emoji/);
      const hosts = describeRefusal({ kind: "too-many-hosts", count: 27 });
      expect(hosts).toMatch(split);
      expect(hosts).toMatch(/27 different hosts/);
    });
  });

  // A secret rule that matches by key substring and hides ANY value hides
  // `payment_token_id: 7`, `token_ids: [1, 2]`, a whole object with a
  // recipient in it.
  describe("secret-like keys hide text, not record ids", () => {
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
        to: secret(17),
        port: 993,
        ssl: true,
      });
      expect(JSON.stringify(out)).not.toContain("evil.com");
    });
  });

  // A regex disagrees with the URL parser the tool uses —
  // `https://fіrma.at\@evil.com/x` reads as evil.com to one, while WHATWG
  // resolves the host to fіrma.at (a backslash is a path separator in a
  // special URL).
  describe("the host a URL resolves to", () => {
    it("annotates the host the URL parser resolves, not the one a regex reads", () => {
      const value = "https://fіrma.at\\@evil.com/x";
      const out = summarizeArgs({ url: value });
      expect(out.url).toEqual(hosted(value, new URL(value).hostname));
      expect(new URL(value).hostname).toBe("xn--frma-l9d.at");
    });

    it("names the real host when the text reads as a different one", () => {
      const value = "https://evil.com\\@firma.at/x";
      expect(summarizeArgs({ website: value }).website).toEqual(hosted(value, "evil.com"));
    });

    it("names the host behind percent-encoding and numeric forms", () => {
      expect(summarizeArgs({ url: "https://fir%6Da.at/" }).url).toEqual(
        hosted("https://fir%6Da.at/", "firma.at")
      );
      expect(summarizeArgs({ url: "http://0x7f.1/" }).url).toEqual(
        hosted("http://0x7f.1/", "127.0.0.1")
      );
    });

    it("leaves a URL whose host reads as it resolves alone, case aside", () => {
      expect(summarizeArgs({ url: "https://Firma.at/pay" }).url).toBe("https://Firma.at/pay");
    });
  });

  // A regex wanting `scheme://` at position 0 decides URL-ness wrongly: the
  // WHATWG parser pinchy_web_fetch uses (`new URL(url)`) takes far more — no
  // slashes, one slash, backslashes, and a leading control or space it
  // strips. Each of those reaches `xn--frma-l9d.at`.
  describe("a URL is what the parser accepts, not what a regex reads", () => {
    const homoglyph = "xn--frma-l9d.at";

    it.each([
      ["no slashes", "https:fіrma.at/x", homoglyph],
      ["one slash", "https:/fіrma.at/x", homoglyph],
      ["backslashes", "https:\\\\fіrma.at\\x", homoglyph],
      ["backslashes and percent-encoding", "https:\\\\fir%6Da.at\\x", "firma.at"],
    ])("names the host of a URL written with %s", (_shape, value, host) => {
      expect(new URL(value).hostname).toBe(host);
      expect(summarizeArgs({ url: value }).url).toEqual(hosted(value, host));
      expect(summarizeArgs({ website: value }).website).toEqual(hosted(value, host));
    });

    it("names the host of a URL behind a control character the parser strips", () => {
      const value = "\u0001https://fіrma.at/x";
      expect(new URL(value).hostname).toBe(homoglyph);
      expect(summarizeArgs({ website: value }).website).toEqual(
        hosted("⟨U+0001⟩https://fіrma.at/x", homoglyph)
      );
    });

    // A person reads the text after `//` as the host; the parser reads the
    // part after the last `@`. Any userinfo is a reason to say which.
    it.each([
      ["https://firma.at@evil.com/x", "evil.com"],
      ["https://firma.at:pw@evil.com/x", "evil.com"],
      ["https://firma.at:pw@firma.at/x", "firma.at"],
    ])("names the host of %j, which carries userinfo", (value, host) => {
      expect(summarizeArgs({ website: value }).website).toEqual(hosted(value, host));
    });

    it("leaves a URL alone whose text shows its host right after `//`", () => {
      for (const value of [
        "https://firma.at",
        "https://firma.at/pay?x=1#y",
        "https://firma.at:8443/pay",
        "http://[::1]:8080/",
      ]) {
        expect(summarizeArgs({ website: value }).website).toBe(value);
      }
    });

    // Free text that merely begins with a URL is not a URL: a pattern matched
    // against the start of the text would read it as one and note it as "not
    // a valid URL". The parser refuses each of these, so none gets a note.
    it.each([
      "https://firma.at\nHi team, the new site is live.",
      "https://firma.at — new site is live",
      "https://firma.at, see above",
      "https://exa mple.com",
    ])("gives free text that begins with a URL no note: %j", (value) => {
      expect(summarizeArgs({ note: value }).note).toBe(value);
    });

    // An email address is read the way the mail tool reads one
    // (`parseSingleRecipient`): trimmed, and taken out of `Name <…>`.
    it.each([
      ["Boss <boss@fіrma.at>", "Boss <boss@fіrma.at>"],
      ['"Boss" <boss@fіrma.at>', '"Boss" <boss@fіrma.at>'],
      [" boss@fіrma.at", " boss@fіrma.at"],
      ["boss@fіrma.at ", "boss@fіrma.at⟨U+00A0⟩"],
    ])("names the punycode host of the address in %j", (value, shown) => {
      expect(summarizeArgs({ email: value }).email).toEqual(hosted(shown, homoglyph));
    });

    it("leaves free text that merely holds an address alone", () => {
      for (const value of [
        "Bitte an <boss@fіrma.at>, danke",
        "Schreib an boss@fіrma.at bitte",
        "a@fіrma.at, b@fіrma.at",
      ]) {
        expect(summarizeArgs({ note: value }).note).toBe(value);
      }
    });
  });
});
