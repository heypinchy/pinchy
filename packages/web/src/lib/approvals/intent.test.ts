import { describe, expect, it } from "vitest";
import { summarizeArgs } from "@/test-helpers/approvals";
import {
  describeIntent,
  humanLabels,
  isTable,
  rowsLayout,
  type Intent,
  type PhrasePart,
} from "./intent";

/** The headline as plain text, each value written as ‹value›. */
function headline(intent: Intent): string {
  return intent.headline
    .map((part: PhrasePart) => {
      if (typeof part === "string") return part;
      if ("code" in part) return `\`${part.code}\``;
      if ("model" in part) return `${part.model ?? ""}‹${String(part.value)}›`;
      return `‹${typeof part.value === "string" ? part.value : JSON.stringify(part.value)}›`;
    })
    .join("");
}

const labels = (intent: Intent) => intent.sections.map((section) => section.label);

describe("describeIntent says what a call does, in words", () => {
  it("names the file, its format and the size of its table", () => {
    const summary = summarizeArgs({
      filename: "test",
      format: "csv",
      columns: ["Name", "Wert"],
      rows: [["A", 1]],
    });
    const intent = describeIntent("pinchy_generate_file", summary);
    expect(intent.action).toBe("Create a file");
    expect(headline(intent)).toBe("Create a CSV file named ‹test› with 2 columns and 1 row");
    expect(intent.sections).toEqual([
      { label: "File name", value: "test" },
      { label: "Contents", table: { columns: ["Name", "Wert"], rows: [["A", 1]] } },
    ]);
    expect([...intent.shown].sort()).toEqual(["columns", "filename", "format", "rows"]);
  });

  it("names an Excel file and a PDF by what people call them", () => {
    const base = { filename: "q3", columns: ["a"], rows: [["1"], ["2"]] };
    expect(headline(describeIntent("pinchy_generate_file", { ...base, format: "xlsx" }))).toBe(
      "Create an Excel file named ‹q3› with 1 column and 2 rows"
    );
    expect(headline(describeIntent("pinchy_generate_file", { ...base, format: "pdf" }))).toBe(
      "Create a PDF file named ‹q3› with 1 column and 2 rows"
    );
  });

  // An object lookup would find `Object.prototype.constructor` under these.
  it.each(["constructor", "__proto__", "toString"])(
    "names no format for %s, which only an object lookup would find",
    (format) => {
      const intent = describeIntent("pinchy_generate_file", { filename: "q", format });
      expect(headline(intent)).toBe("Create a file named ‹q›");
      expect(intent.shown.has("format")).toBe(false);
    }
  );

  it("leaves a format it does not know to the field list, unnamed", () => {
    const intent = describeIntent("pinchy_generate_file", {
      filename: "q3",
      format: "csv​",
      columns: ["a"],
      rows: [["1"]],
    });
    expect(headline(intent)).toBe("Create a file named ‹q3› with 1 column and 1 row");
    expect(intent.shown.has("format")).toBe(false);
  });

  it("shows a title with the table", () => {
    const intent = describeIntent("pinchy_generate_file", {
      filename: "q3",
      format: "pdf",
      title: "Quarter",
      columns: ["a"],
      rows: [["1"]],
    });
    expect(labels(intent)).toEqual(["File name", "Title", "Contents"]);
    expect(intent.shown.has("title")).toBe(true);
  });

  // `rows` as a table is a claim about its shape. A value of any other shape
  // is not drawn as one: it stays in the field list, drawn as it is.
  it.each([
    ["rows that are not lists", { columns: ["a"], rows: ["x"] }],
    ["an empty row, which a table would draw as nothing", { columns: ["a"], rows: [[]] }],
    ["a cell that is an object", { columns: ["a"], rows: [[{ x: 1 }]] }],
    ["a cell that is a list", { columns: ["a"], rows: [[["x"]]] }],
    ["columns that are not a list", { columns: "a", rows: [["1"]] }],
    ["a column that is an object", { columns: [{ x: 1 }], rows: [["1"]] }],
  ])("draws no table for %s", (_name, args) => {
    const intent = describeIntent("pinchy_generate_file", {
      filename: "q",
      format: "csv",
      ...args,
    });
    expect(intent.sections.some((section) => "table" in section)).toBe(false);
    expect(intent.shown.has("rows")).toBe(false);
    expect(intent.shown.has("columns")).toBe(false);
    expect(headline(intent)).toBe("Create a CSV file named ‹q›");
  });

  it("puts the recipient and subject of an email into the sentence, and the mail below", () => {
    const summary = summarizeArgs({ to: "ada@example.com", subject: "Q3 numbers", body: "Hi Ada" });
    const intent = describeIntent("email_send", summary);
    expect(intent.action).toBe("Send an email");
    expect(headline(intent)).toBe(
      "Send an email to ‹ada@example.com› with the subject ‹Q3 numbers›"
    );
    expect(labels(intent)).toEqual(["To", "Subject", "Message"]);
    expect(intent.note).toEqual({
      tone: "warning",
      text: expect.stringMatching(/goes out right away/),
    });
  });

  it("says a draft is not sent", () => {
    const intent = describeIntent("email_draft", {
      to: "ada@example.com",
      subject: "x",
      body: "y",
    });
    expect(intent.action).toBe("Draft an email");
    expect(headline(intent)).toBe("Draft an email to ‹ada@example.com› with the subject ‹x›");
    expect(intent.note).toEqual({ tone: "info", text: expect.stringMatching(/nothing is sent/i) });
  });

  it("keeps the notes on a recipient it puts into the sentence", () => {
    const summary = summarizeArgs({ to: "Boss <boss@x.at>", subject: "Hi", body: "x" });
    const intent = describeIntent("email_send", summary);
    const recipient = intent.headline.find((part) => typeof part !== "string" && "value" in part);
    expect(recipient).toEqual({ value: summary.to });
  });

  it("counts several recipients instead of naming one of them", () => {
    const intent = describeIntent("email_send", { to: ["a@x.at", "b@y.at"], subject: "x" });
    expect(headline(intent)).toBe("Send an email to 2 recipients with the subject ‹x›");
  });

  it("names the reply a mail answers", () => {
    const intent = describeIntent("email_send", {
      to: "a@x.at",
      subject: "x",
      body: "y",
      replyTo: "m1",
    });
    expect(labels(intent)).toEqual(["To", "Subject", "Message", "In reply to"]);
    expect([...intent.shown].sort()).toEqual(["body", "replyTo", "subject", "to"]);
  });

  it("says whether a write creates or replaces a file", () => {
    const create = describeIntent("pinchy_write", { path: "/data/a.md", content: "x" });
    expect(headline(create)).toBe("Create the file ‹/data/a.md›");
    expect(create.note).toBeNull();
    expect(labels(create)).toEqual(["File", "Content"]);

    const replace = describeIntent("pinchy_write", {
      path: "/data/a.md",
      content: "x",
      overwrite: true,
    });
    expect(headline(replace)).toBe("Create or replace the file ‹/data/a.md›");
    expect(replace.note?.tone).toBe("warning");
    expect(replace.shown.has("overwrite")).toBe(true);
  });

  it("leaves an overwrite flag that is not a boolean to the field list", () => {
    const intent = describeIntent("pinchy_write", {
      path: "/a.md",
      content: "x",
      overwrite: "true",
    });
    expect(headline(intent)).toBe("Write to the file ‹/a.md›");
    expect(intent.shown.has("overwrite")).toBe(false);
  });

  it("says a deleted file cannot be restored", () => {
    const intent = describeIntent("pinchy_delete", { path: "/data/a.md" });
    expect(headline(intent)).toBe("Delete the file ‹/data/a.md›");
    expect(intent.note).toEqual({
      tone: "warning",
      text: expect.stringMatching(/can't be restored/),
    });
  });

  it("names an Odoo model the way the permissions page does, beside its technical name", () => {
    const intent = describeIntent("odoo_create", {
      model: "res.partner",
      values: { name: "Acme" },
    });
    expect(headline(intent)).toBe("Create a record in Contacts‹res.partner› in Odoo");
    expect(intent.sections).toEqual([
      { label: "Record type", model: "Contacts", value: "res.partner" },
      { label: "Values", value: { name: "Acme" }, fields: true },
    ]);
  });

  it("tells two models with the same name apart by their area", () => {
    const sales = describeIntent("odoo_delete", { model: "sale.order", targets: ["r"] });
    const purchase = describeIntent("odoo_delete", { model: "purchase.order", targets: ["r"] });
    expect(headline(sales)).toBe("Delete 1 record from Sales Orders‹sale.order› in Odoo");
    expect(headline(purchase)).toBe("Delete 1 record from Purchase Orders‹purchase.order› in Odoo");
  });

  it("names a model it does not know by its technical name alone", () => {
    for (const model of ["x_custom.thing", "res.partner​", 7]) {
      const intent = describeIntent("odoo_create", { model, values: {} });
      const part = intent.headline.find((p) => typeof p !== "string" && "model" in p);
      expect(part).toEqual({ model: null, value: model });
    }
  });

  it("counts the records an Odoo write changes and a delete removes", () => {
    const write = describeIntent("odoo_write", {
      model: "res.partner",
      ids: [7, 8],
      values: { name: "x" },
    });
    expect(headline(write)).toBe("Update 2 records in Contacts‹res.partner› in Odoo");
    expect(labels(write)).toEqual(["Record type", "Records", "Changes"]);

    const remove = describeIntent("odoo_delete", { model: "res.partner", targets: ["r1"] });
    expect(headline(remove)).toBe("Delete 1 record from Contacts‹res.partner› in Odoo");
    expect(remove.note?.tone).toBe("warning");
  });

  it("says when a vendor bill is filed even though one with its reference exists", () => {
    const intent = describeIntent("odoo_create", {
      model: "account.move",
      values: {},
      allow_duplicate: true,
    });
    expect(intent.note).toEqual({
      tone: "warning",
      text: expect.stringMatching(/already on file/),
    });
    expect(intent.shown.has("allow_duplicate")).toBe(true);
  });

  it("uses the tool's name from the catalogue for every other tool", () => {
    const intent = describeIntent("odoo_confirm_order", { ref: "x" });
    expect(intent.action).toBe("Odoo: Confirm sale order");
    expect(headline(intent)).toBe("Odoo: Confirm sale order");
    expect(intent.sections).toEqual([]);
    expect(intent.shown.size).toBe(0);
  });

  it("names a tool the catalogue does not know by its id", () => {
    const intent = describeIntent("pinchy_save_user_context", { content: "x" });
    expect(intent.action).toBe("Use the tool pinchy_save_user_context");
    expect(headline(intent)).toBe("Use the tool `pinchy_save_user_context`");
  });

  it("describes a call with no arguments", () => {
    expect(headline(describeIntent("email_send", null))).toBe("Send an email");
    expect(headline(describeIntent("pinchy_generate_file", {}))).toBe("Create a file");
  });
});

/**
 * The headline repeats a value only when it is short and on one line. A long
 * one would crowd out the sentence and add to what the card costs to draw;
 * the section below shows it, whole or previewed.
 */
describe("which values the headline repeats", () => {
  it("repeats a short value, the very value the summary holds", () => {
    const summary = { path: "/data/a.md", content: "x" };
    const part = describeIntent("pinchy_delete", summary).headline.find(
      (p) => typeof p !== "string" && "value" in p
    ) as { value: unknown };
    expect(part.value).toBe(summary.path);
  });

  it.each([
    ["a long value", "a".repeat(121)],
    ["a value over several lines", "a\nb"],
    ["a previewed text", { "@": "previewed", text: "x".repeat(300), preview: 200, parts: [300] }],
    ["an emoji-heavy value", "📄".repeat(2)],
  ])("leaves out %s", (_name, path) => {
    const intent = describeIntent("pinchy_delete", { path });
    expect(headline(intent)).toBe("Delete a file");
    expect(labels(intent)).toEqual(["File"]);
  });
});

describe("humanLabels", () => {
  it("writes a field name in words", () => {
    expect(
      Object.fromEntries(
        humanLabels(["partner_id", "invoice_line_ids", "replyTo", "website_url", "name"])
      )
    ).toEqual({
      partner_id: "Partner ID",
      invoice_line_ids: "Invoice line IDs",
      replyTo: "replyTo",
      website_url: "Website URL",
      name: "Name",
    });
  });

  // Two names that read alike in words would be two rows with one label.
  it("keeps the names as they are where two would read alike", () => {
    expect(Object.fromEntries(humanLabels(["send_at", "send-at", "name"]))).toEqual({
      send_at: "send_at",
      "send-at": "send-at",
      name: "Name",
    });
  });

  it("writes a field named like an object's own property in words too", () => {
    expect(Object.fromEntries(humanLabels(["constructor", "to_string"]))).toEqual({
      constructor: "Constructor",
      to_string: "To string",
    });
  });

  it("keeps a quoted or unusual name as the summary wrote it", () => {
    expect(Object.fromEntries(humanLabels(['"to "', "to", "_private"]))).toEqual({
      '"to "': '"to "',
      to: "To",
      _private: "_private",
    });
  });
});

describe("review: what the card draws stays within what the summary charged", () => {
  // Padded to the widest row, one row of 200 cells under 199 rows of one
  // would draw 40,000 cells the summary charged as 400.
  it.each([
    ["ragged rows", { columns: ["a"], rows: [["1"], ["1", "2"]] }],
    ["rows wider than the columns", { columns: ["a"], rows: [["1", "2"]] }],
    ["rows narrower than the columns", { columns: ["a", "b"], rows: [["1"]] }],
  ])("draws no table for %s", (_name, args) => {
    const intent = describeIntent("pinchy_generate_file", {
      filename: "q",
      format: "csv",
      ...args,
    });
    expect(intent.sections.some((section) => "table" in section)).toBe(false);
    expect(intent.shown.has("rows")).toBe(false);
  });

  it("says a rectangular list of rows is a table, and a ragged one is not", () => {
    expect(
      isTable([
        ["a", "b"],
        ["c", "d"],
      ])
    ).toBe(true);
    expect(isTable([["a"], ["b", "c"]])).toBe(false);
    expect(isTable([["a"]], 2)).toBe(false);
    expect(isTable([])).toBe(false);
  });

  it("leaves an Odoo model out of the sentence when it is long and unknown", () => {
    const model = "x".repeat(500);
    const intent = describeIntent("odoo_create", { model, values: {} });
    expect(headline(intent)).toBe("Create a record in Odoo");
    expect(intent.sections[0]).toEqual({ label: "Record type", model: null, value: model });
  });

  it("leaves a recipient out of the sentence when its name is long or spans lines", () => {
    for (const name of ["N".repeat(300), "Line one\nLine two"]) {
      const summary = summarizeArgs({ to: `"${name}" <a@b.at>`, subject: "x" });
      expect(headline(describeIntent("email_send", summary))).toBe(
        "Send an email with the subject ‹x›"
      );
    }
  });

  it("counts a record named twice once", () => {
    const write = describeIntent("odoo_write", { model: "res.partner", ids: [7, 7], values: {} });
    expect(headline(write)).toBe("Update 1 record in Contacts‹res.partner› in Odoo");
  });

  it("lists allow_duplicate: false with the other fields, since the sentence does not say it", () => {
    const intent = describeIntent("odoo_create", {
      model: "account.move",
      values: {},
      allow_duplicate: false,
    });
    expect(intent.shown.has("allow_duplicate")).toBe(false);
    expect(intent.note).toBeNull();
  });

  it("keeps a field name raw where its words would read like a label already on the card", () => {
    expect(Object.fromEntries(humanLabels(["Subject", "notify"], ["To", "Subject"]))).toEqual({
      Subject: "Subject",
      notify: "Notify",
    });
    expect(Object.fromEntries(humanLabels(["subject"], ["Subject"]))).toEqual({
      subject: "subject",
    });
  });
});

describe("review: wording", () => {
  it("says 'a file' where it cannot name the file", () => {
    expect(headline(describeIntent("pinchy_write", { content: "x" }))).toBe("Create a file");
    expect(headline(describeIntent("pinchy_write", { content: "x", overwrite: true }))).toBe(
      "Create or replace a file"
    );
  });

  it("says a replaced file's old content can't be recovered, without claiming it exists", () => {
    const intent = describeIntent("pinchy_write", { path: "/a.md", content: "x", overwrite: true });
    expect(intent.note?.text).toBe(
      "If this file already exists, what it holds now is overwritten and can't be recovered."
    );
  });

  it("does not speak of a bill for a record that is not one", () => {
    const intent = describeIntent("odoo_create", {
      model: "res.partner",
      values: {},
      allow_duplicate: true,
    });
    expect(intent.note).toBeNull();
    expect(intent.shown.has("allow_duplicate")).toBe(false);
  });

  it("spells out common abbreviations in field names", () => {
    expect(Object.fromEntries(humanLabels(["vat", "uom_id", "iban", "bcc", "body_html"]))).toEqual({
      vat: "VAT",
      uom_id: "UoM ID",
      iban: "IBAN",
      bcc: "BCC",
      body_html: "Body HTML",
    });
  });
});

describe("rowsLayout: how rows fit the card, every value whole", () => {
  it("draws up to three columns of short values as a table", () => {
    expect(rowsLayout(["Customer", "Invoice", "Amount"], [["Acme GmbH", "INV-1", 1240.5]])).toEqual(
      {
        kind: "table",
      }
    );
  });

  it("draws more than three columns as blocks that repeat each column's name", () => {
    expect(rowsLayout(["a", "b", "c", "d"], [["1", "2", "3", "4"]])).toEqual({
      kind: "blocks",
      repeatLabels: true,
    });
  });

  // An address does not wrap, so it would push the third column past the
  // corner card's edge, where nothing says it is there.
  it("draws a row holding a long unbreakable value as blocks, however few columns", () => {
    expect(rowsLayout(["Name", "Email"], [["Anna", "anna.schmidt@nordwind-logistik.de"]])).toEqual({
      kind: "blocks",
      repeatLabels: true,
    });
    expect(rowsLayout(["anna.schmidt@nordwind-logistik.de"], [["1"]])).toEqual({
      kind: "blocks",
      repeatLabels: true,
    });
  });

  // Repeated in every row, costly column names would draw far more than the
  // summary charged against DRAW_BUDGET; they are drawn once instead.
  it("names columns once when repeating their names would cost too much to draw", () => {
    const label = "📄".repeat(31);
    const rows = Array.from({ length: 120 }, () => ["", "", "", ""]);
    expect(rowsLayout([label, label, label, label], rows)).toEqual({
      kind: "blocks",
      repeatLabels: false,
    });
  });
});

// The summary charges a field name by its length as sent (DRAW_BUDGET); a
// name written in words must draw no more characters than that.
describe("a field name in words draws as many characters as the name", () => {
  it.each(["partner_id", "invoice_line_ids", "replyTo", "sendAt", "uom_id", "is-company", "a"])(
    "%s",
    (key) => {
      const label = humanLabels([key]).get(key)!;
      expect([...label].length).toBe([...key].length);
    }
  );
});
