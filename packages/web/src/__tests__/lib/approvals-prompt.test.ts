import { describe, it, expect, beforeAll } from "vitest";
import {
  buildApprovalPrompt,
  APPROVAL_TITLE_MAX,
  APPROVAL_DESCRIPTION_MAX,
} from "@/lib/approvals/prompt";
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
describe("buildApprovalPrompt", () => {
  it("names the action rather than the function", () => {
    const { title } = buildApprovalPrompt("pinchy_web_search", { query: "acme gmbh" });
    expect(title).toBe("Search the web");
    expect(title).not.toContain("pinchy_web_search");
  });

  it("puts the target in the description, so the reviewer sees what it acts on", () => {
    const { description } = buildApprovalPrompt("pinchy_web_search", {
      query: "acme gmbh",
    });
    expect(description).toContain("acme gmbh");
  });

  it("still says something usable for a tool the registry does not know", () => {
    // knowledge_search reaches an agent through the Knowledge Base template and
    // is in no registry — the same gap that made the confirmation list render
    // empty in #865. A prompt builder that returned nothing here would put an
    // unlabelled card in front of the user.
    const { title, description } = buildApprovalPrompt("knowledge_search", {
      query: "vacation policy",
    });
    expect(title.length).toBeGreaterThan(0);
    expect(title).toContain("knowledge_search");
    expect(description).toContain("vacation policy");
  });

  it("keeps both fields inside the gateway's hard caps", () => {
    const { title, description } = buildApprovalPrompt("pinchy_write", {
      path: "a/very/long/path/".repeat(40),
      content: "x".repeat(5000),
    });
    expect(title.length).toBeLessThanOrEqual(APPROVAL_TITLE_MAX);
    expect(description.length).toBeLessThanOrEqual(APPROVAL_DESCRIPTION_MAX);
  });

  it("truncates visibly rather than cutting a word mid-air", () => {
    const { description } = buildApprovalPrompt("pinchy_write", {
      content: "y".repeat(5000),
    });
    expect(description.endsWith("…")).toBe(true);
  });

  it("does not carry a secret-looking argument into the approval surface", () => {
    // The prompt is delivered to every connected approval surface, including
    // chat channels. summarizeArgs already redacts these for the card; the
    // same redaction has to hold here or the safer surface leaks what the
    // riskier one hides.
    const { description } = buildApprovalPrompt("pinchy_web_fetch", {
      url: "https://example.com",
      api_key: "sk-live-must-not-appear",
    });
    expect(description).not.toContain("sk-live-must-not-appear");
  });

  it("has no argument text at all when the call carries none", () => {
    const { description } = buildApprovalPrompt("pinchy_web_search", {});
    expect(description.length).toBeGreaterThan(0);
    expect(description).not.toContain("undefined");
    expect(description).not.toContain("{}");
  });

  // #1133. Once deletion can be gated per model, "Delete a record in Odoo" is
  // not a decision anyone can make — the whole point of the setting is that
  // an invoice and a note are different answers. The resources the gate
  // resolved are what the card has to show.
  it("names the resource the call acts on", () => {
    const { title } = buildApprovalPrompt("odoo_delete", { ids: [7] }, ["account.move"]);
    expect(title).toContain("account.move");
  });

  it("names every resource of a call that spans more than one", () => {
    const { title } = buildApprovalPrompt("odoo_reconcile", {}, [
      "account.move",
      "account.payment",
    ]);
    expect(title).toContain("account.move");
    expect(title).toContain("account.payment");
  });

  it("says nothing about resources when the call names none", () => {
    const bare = buildApprovalPrompt("email_send", { to: "ada@example.com" });
    const empty = buildApprovalPrompt("email_send", { to: "ada@example.com" }, []);
    expect(empty.title).toBe(bare.title);
    expect(empty.title).not.toContain("—");
  });

  // A ref the model garbled resolves to `null`. Printing that would put the
  // word "null" on a security prompt; the honest rendering is to leave the
  // resource unstated and let the tool name carry the meaning.
  it("does not print an unnamed resource", () => {
    const { title } = buildApprovalPrompt("odoo_confirm_order", {}, [null]);
    expect(title.toLowerCase()).not.toContain("null");
  });

  it("keeps the title inside the cap even with many resources", () => {
    const { title } = buildApprovalPrompt(
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
  // Corrected input (second review of #1242): this used a fake "pinchy_ref:v1:
  // AAAA…" string, which only stayed out of the description because ANY string
  // with that prefix was hidden — the hole that let a prefixed email body
  // vanish. A real ref is replaced by the record it names; a fake one is text.
  it("does not fill the description with an opaque ref token", () => {
    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "c1",
      model: "sale.order",
      id: 9,
      label: "S00009",
    });
    const { description } = buildApprovalPrompt(
      "odoo_confirm_order",
      { target: ref },
      ["sale.order"],
      { refRecord: makeRefResolver(REF_KEY) }
    );
    expect(description).not.toContain(ref.slice(20, 40));
    expect(description).toContain('(record reference: sale.order #9 "S00009")');
  });

  // Fifth review of #1242: a valid ref followed by `=` and text decoded to the
  // record, so the prompt named the record and dropped the text the tool
  // would send.
  it("shows the text after a ref, not the record it seems to name", () => {
    const ref = encodeRef({
      integrationType: "odoo",
      connectionId: "c1",
      model: "res.partner",
      id: 7,
      label: "Raimund Korber",
    });
    const { description } = buildApprovalPrompt(
      "email_send",
      { to: "kunde@example.com", body: `${ref}=\n\nBitte überweisen Sie an AT00 1234` },
      [],
      { refRecord: makeRefResolver(REF_KEY) }
    );
    expect(description).not.toContain("record reference");
    expect(description).toContain(ref.slice(0, 40));
  });

  it("shows free text that starts with the ref prefix as the text it is", () => {
    const { description } = buildApprovalPrompt("email_send", {
      to: "boss@firma.at",
      subject: "pinchy_ref:v1: Neue Bankverbindung",
    });
    expect(description).toContain("pinchy_ref:v1: Neue Bankverbindung");
  });

  // Odoo reads bool("false") as True — on a security prompt the string and the
  // boolean must not print alike.
  it("tells a string that reads like a literal apart from the literal", () => {
    const { description } = buildApprovalPrompt("odoo_write", {
      values: { active: "false", is_company: false, x: null },
    });
    expect(description).toContain('active: "false"');
    expect(description).toContain("is_company: false");
    expect(description).toContain("x: null");
  });

  it("names the recipient's address before a padded display name", () => {
    const { description } = buildApprovalPrompt("email_send", {
      to: `Raimund Korber${"\u2800".repeat(190)} <attacker@evil.com>`,
      subject: "Rechnung",
    });
    expect(description).toContain("to: attacker@evil.com (name: ");
  });
  // The prompt reaches chat surfaces too, and it reads the same summary as the
  // card. Once the summary keeps real arrays/objects, flattening them with
  // String() would print "[object Object]" on a security prompt.
  it("spells out nested arguments instead of printing [object Object]", () => {
    const { description } = buildApprovalPrompt("odoo_write", {
      ids: [7],
      values: { acc_number: "AT61 1904", amount: 99999 },
    });
    expect(description).not.toContain("[object Object]");
    expect(description).toContain("acc_number: AT61 1904");
    expect(description).toContain("99999");
  });

  it("lists every recipient, including one smuggled behind padding", () => {
    const { description } = buildApprovalPrompt("email_send", {
      to: `chef@firma.at${" ".repeat(300)}, angreifer@evil.com`,
    });
    expect(description).toContain("chef@firma.at");
    expect(description).toContain("angreifer@evil.com");
  });
  // Third review of #1242: a CRLF mail body printed "⟨U+000D⟩" before every
  // line break on the chat prompt, as on the card.
  it("renders a CRLF body as line breaks", () => {
    const { description } = buildApprovalPrompt("email_send", {
      to: "a@x.at",
      body: "Hallo,\r\nzweite Zeile\rx",
    });
    expect(description).toContain("body: Hallo,\nzweite Zeile⟨U+000D⟩x");
  });

  it("never cuts the description between the halves of an emoji", () => {
    for (let pad = 0; pad < 4; pad++) {
      const { description } = buildApprovalPrompt("email_send", {
        to: "a@x.at",
        body: `${"x".repeat(pad)}${"😀".repeat(300)}`,
      });
      expect(description).not.toMatch(
        /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/
      );
    }
  });
});
