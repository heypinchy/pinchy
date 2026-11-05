/**
 * What a gated tool call does, in words a person reads before approving it
 * (#1310). The card used to say "Run `pinchy_generate_file` with:" and list
 * raw parameter names; this module turns the same call into a sentence
 * ("Create a CSV file named test with 2 columns and 1 row"), a preview of
 * its effect, and the list of values it leaves to the field list.
 *
 * THE RULE, from #1242: what the card shows is what will run. So this module
 * reads nothing but the stored summary (`summarizeCall`), which is derived
 * from the call's actual parameters, never from what the model wrote about
 * them — and it adds no value of its own:
 *
 * - Every value in the sentence or a section is the summary's own value, by
 *   reference, drawn by the same code the field list draws it with. Our words
 *   only ever surround values; they never stand in for one, except where a
 *   value maps one to one onto words (a known format, a known Odoo model,
 *   a boolean flag) — and an Odoo model is still drawn beside its name.
 * - `shown` names the top-level keys a section draws whole (or the sentence
 *   says in words). The card draws every other key in the field list, so no
 *   key is left out because a tool has a preview: a call with a field this
 *   module does not expect shows it like any other.
 * - A section claims a shape (a table) only when the value has that shape;
 *   otherwise the key stays unclaimed and is drawn as it is.
 *
 * Pure and client-safe: no `node:` import, no parser that differs between
 * browsers. The card calls it.
 */
import { TOOL_REGISTRY } from "@/lib/tool-registry";
import { MODEL_CATEGORIES } from "@/lib/integrations/odoo-model-catalog";
import { DRAW_BUDGET, drawCost, drawnOf, readNode, readShown } from "./display";

/** A piece of the headline: our words, a tool id, a summary value, or a model. */
export type PhrasePart =
  | string
  | { code: string }
  | { value: unknown }
  /** An Odoo model: its name in words where the catalogue knows it, and the value. */
  | { model: string | null; value: unknown };

export type Section =
  /** A summary value, drawn as the field list draws it; `fields` humanises an object's keys. */
  | { label: string; value: unknown; fields?: true }
  | { label: string; model: string | null; value: unknown }
  /** `pinchy_generate_file`'s columns and rows, drawn as the table it writes. */
  | { label: string; table: { columns: unknown[]; rows: unknown[][] } };

export interface Intent {
  /** What the call does, without any value: for the closed card and labels. */
  action: string;
  headline: PhrasePart[];
  note: { tone: "info" | "warning"; text: string } | null;
  sections: Section[];
  /** Top-level keys the sections or the headline show whole. */
  shown: ReadonlySet<string>;
}

/**
 * The most a value the headline repeats may cost to draw (`drawCost`): about
 * a long file path or address. The card's DRAW_BUDGET bounds what the summary
 * draws; the headline repeats at most three such values on top of it.
 */
export const HEADLINE_VALUE_COST = 121;

/**
 * A value short enough, and on one line, to repeat in the headline — counting
 * every note the headline draws beside it too (a recipient's name).
 */
function inline(value: unknown): boolean {
  if (typeof value === "number" || typeof value === "boolean") return true;
  const node = readNode(value);
  const noted = node && node !== "unreadable" && node["@"] === "noted" ? node : null;
  const texts: unknown[] = noted
    ? [noted.text, ...noted.notes.map((note) => (note.kind === "name" ? note.name : note.host))]
    : [readShown(value)];
  let cost = 0;
  for (const shown of texts) {
    // A previewed text is too long for the headline by definition.
    if (typeof shown !== "string") return false;
    const drawn = drawnOf(shown);
    if (drawn.includes("\n")) return false;
    cost += drawCost(drawn);
  }
  return cost <= HEADLINE_VALUE_COST;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/** A Map, not an object: `format: "constructor"` must not find Object's own property. */
const FORMAT_NAMES: ReadonlyMap<string, string> = new Map([
  ["csv", "a CSV"],
  ["xlsx", "an Excel"],
  ["pdf", "a PDF"],
]);

/**
 * The catalogue's name for each Odoo model. A name two areas share ("Orders"
 * in Sales and in Purchase) is said with its area ("Sales Orders").
 */
const MODEL_NAMES: ReadonlyMap<string, string> = (() => {
  const all = MODEL_CATEGORIES.flatMap((category) =>
    category.models.map((entry) => ({ ...entry, area: category.label }))
  );
  const count = new Map<string, number>();
  for (const { name } of all) count.set(name, (count.get(name) ?? 0) + 1);
  return new Map(
    all.map(({ model, name, area }) => [model, count.get(name)! > 1 ? `${area} ${name}` : name])
  );
})();

/** The name of the model a value names exactly, or null. */
function modelName(value: unknown): string | null {
  return typeof value === "string" ? (MODEL_NAMES.get(value) ?? null) : null;
}

/** Builds an intent, keeping track of which keys it shows. */
class Builder {
  readonly headline: PhrasePart[] = [];
  readonly sections: Section[] = [];
  readonly shown = new Set<string>();
  note: Intent["note"] = null;

  constructor(readonly args: Record<string, unknown>) {}

  has(key: string): boolean {
    return Object.hasOwn(this.args, key);
  }

  say(...parts: PhrasePart[]): this {
    this.headline.push(...parts);
    return this;
  }

  /** Whether the value at `key` is short enough for the headline. */
  canSay(key: string): boolean {
    return this.has(key) && inline(this.args[key]);
  }

  /** Says `before` and the value at `key` when the value is short enough. */
  sayValue(before: string, key: string): this {
    if (this.canSay(key)) this.say(before, { value: this.args[key] });
    return this;
  }

  section(label: string, key: string, fields?: true): this {
    if (!this.has(key)) return this;
    this.sections.push(
      fields ? { label, value: this.args[key], fields } : { label, value: this.args[key] }
    );
    this.shown.add(key);
    return this;
  }

  /** A key whose value the headline already says in words. */
  said(key: string): this {
    this.shown.add(key);
    return this;
  }

  build(action: string): Intent {
    return {
      action,
      headline: this.headline,
      note: this.note,
      sections: this.sections,
      shown: this.shown,
    };
  }
}

/** A cell or column name a table can draw: not a list, not a plain object. */
function isCell(value: unknown): boolean {
  if (Array.isArray(value)) return false;
  if (value !== null && typeof value === "object") {
    const node = readNode(value);
    return node !== null && node !== "unreadable";
  }
  return true;
}

/**
 * Whether `rows` draws as a table cell for cell: at least one row, every row
 * the same length (`width`, when the columns fix it) and made of cells. A
 * ragged list is not a table — padded to its widest row it would draw cells
 * the summary never charged against DRAW_BUDGET (one wide row under hundreds
 * of narrow ones draws tens of thousands), and `pinchy_generate_file` refuses
 * it anyway.
 */
export function isTable(rows: unknown, width?: number): rows is unknown[][] {
  if (!Array.isArray(rows) || rows.length === 0) return false;
  const length = width ?? (Array.isArray(rows[0]) ? rows[0].length : 0);
  return (
    length > 0 &&
    rows.every((row) => Array.isArray(row) && row.length === length && row.every(isCell))
  );
}

/** The most columns drawn as a table; wider rows are drawn as blocks. */
export const TABLE_MAX_COLUMNS = 3;

/** The longest run without a space a table cell holds before it would not fit. */
const TABLE_MAX_RUN = 20;

/**
 * What repeating the column names in every block may cost to draw, on top of
 * what the summary charged (DRAW_BUDGET counts each name once).
 */
const REPEAT_BUDGET = DRAW_BUDGET / 2;

/**
 * The text a cell or column name draws whole, or null for one drawn otherwise:
 * as an annotation (a record reference, a hidden secret) or as a preview.
 */
function cellText(value: unknown): string | null {
  if (typeof value === "number" || typeof value === "boolean" || value === null) {
    return String(value);
  }
  const node = readNode(value);
  const shown =
    node && node !== "unreadable" && node["@"] === "noted" ? node.text : readShown(value);
  return typeof shown === "string" ? drawnOf(shown) : null;
}

/** Whether a cell is too wide for a table column: a long run, or not plain text. */
function hasLongRun(value: unknown): boolean {
  const text = cellText(value);
  if (text === null) return true;
  return text.split(/\s+/).some((run) => [...run].length > TABLE_MAX_RUN);
}

/** What drawing a column name costs (`drawCost`); an annotation by its JSON size. */
function labelCost(value: unknown): number {
  const text = cellText(value);
  return text === null ? JSON.stringify(value).length : drawCost(text);
}

/**
 * How rectangular rows (`isTable`) are drawn so every value stays whole and
 * in view, decided from the values alone so every browser draws the same:
 *
 * - `table`: up to TABLE_MAX_COLUMNS columns, no value with a run longer than
 *   TABLE_MAX_RUN. A table sizes a column to its longest unbreakable run, so
 *   an address would push the next column past the corner card's edge.
 * - `blocks`: one block per row, each value under its column's name. The
 *   names repeat in every block only while that stays within REPEAT_BUDGET;
 *   past it they are drawn once, in a legend, and the blocks say "Column N".
 */
export function rowsLayout(
  columns: readonly unknown[],
  rows: readonly unknown[][]
): { kind: "table" } | { kind: "blocks"; repeatLabels: boolean } {
  const width = rows[0]?.length ?? 0;
  const fits =
    width <= TABLE_MAX_COLUMNS &&
    !columns.some(hasLongRun) &&
    !rows.some((row) => row.some(hasLongRun));
  if (fits) return { kind: "table" };
  const perRow = columns.reduce<number>((sum, column) => sum + labelCost(column), 0);
  return { kind: "blocks", repeatLabels: perRow * rows.length <= REPEAT_BUDGET };
}

function generateFile(b: Builder): Intent {
  const { format, columns, rows } = b.args;
  const formatName = typeof format === "string" ? FORMAT_NAMES.get(format) : undefined;
  b.say(formatName ? `Create ${formatName} file` : "Create a file");
  if (formatName) b.said("format");
  b.sayValue(" named ", "filename");
  const table = Array.isArray(columns) && columns.every(isCell) && isTable(rows, columns.length);
  if (table) {
    b.say(` with ${plural(columns.length, "column")} and ${plural(rows.length, "row")}`);
  }
  b.section("File name", "filename").section("Title", "title");
  if (table) {
    b.sections.push({ label: "Contents", table: { columns, rows } });
    b.said("columns").said("rows");
  }
  return b.build("Create a file");
}

function email(b: Builder, send: boolean): Intent {
  b.say(send ? "Send an email" : "Draft an email");
  const { to } = b.args;
  if (Array.isArray(to) && to.length > 1) b.say(` to ${plural(to.length, "recipient")}`);
  else b.sayValue(" to ", "to");
  b.sayValue(" with the subject ", "subject");
  b.section("To", "to").section("Subject", "subject").section("Message", "body");
  b.section("In reply to", "replyTo");
  b.note = send
    ? { tone: "warning", text: "It goes out right away and can't be unsent." }
    : { tone: "info", text: "It's saved as a draft. Nothing is sent." };
  return b.build(send ? "Send an email" : "Draft an email");
}

function writeFile(b: Builder): Intent {
  const { overwrite } = b.args;
  const replace = overwrite === true;
  const known = overwrite === undefined || typeof overwrite === "boolean";
  // `overwrite: true` also creates a file that does not exist yet.
  const verb = replace ? "Create or replace" : known ? "Create" : "Write to";
  const named = b.canSay("path");
  b.say(`${verb} ${named ? "the" : "a"} file`).sayValue(" ", "path");
  if (known && b.has("overwrite")) b.said("overwrite");
  if (replace) {
    b.note = {
      tone: "warning",
      text: "If this file already exists, what it holds now is overwritten and can't be recovered.",
    };
  }
  b.section("File", "path").section("Content", "content");
  return b.build("Save a file");
}

function deleteFile(b: Builder): Intent {
  b.say(b.canSay("path") ? "Delete the file" : "Delete a file").sayValue(" ", "path");
  b.section("File", "path");
  b.note = { tone: "warning", text: "A deleted file can't be restored." };
  return b.build("Delete a file");
}

/**
 * "2 records" for a list, "records" for anything else. A record named twice
 * is one record — the tools dedupe ids and refs — so it is counted once.
 */
function records(value: unknown): string {
  if (!Array.isArray(value)) return "records";
  return plural(new Set(value.map((item) => JSON.stringify(item))).size, "record");
}

function odoo(b: Builder, verb: "create" | "write" | "delete"): Intent {
  const { model } = b.args;
  const named = { model: modelName(model), value: model };
  if (verb === "create") b.say("Create a record in ");
  if (verb === "write") b.say(`Update ${records(b.args.ids)} in `);
  if (verb === "delete") b.say(`Delete ${records(b.args.targets)} from `);
  // A model the catalogue does not name is repeated only when it is short;
  // the Record type section shows it either way.
  if (b.has("model") && (named.model !== null || inline(model))) b.say(named, " in Odoo");
  else b.say("Odoo");
  if (b.has("model")) {
    b.sections.push({ label: "Record type", ...named });
    b.said("model");
  }
  if (verb === "create") b.section("Values", "values", true);
  if (verb === "write") b.section("Records", "ids").section("Changes", "values", true);
  if (verb === "delete") b.section("Records", "targets");
  if (verb === "delete") b.note = { tone: "warning", text: "Deleted records can't be restored." };
  const duplicate = b.args.allow_duplicate;
  // The flag only matters for a vendor bill (`account.move`); anywhere else
  // it stays in the field list rather than in a note about bills.
  if (verb === "create" && duplicate === true && model === "account.move") {
    b.said("allow_duplicate");
    b.note = {
      tone: "warning",
      text: "It's filed even if a bill with the same reference is already on file.",
    };
  }
  const action = { create: "Create a record", write: "Update records", delete: "Delete records" };
  return b.build(`${action[verb]} in Odoo`);
}

/** Says what `toolName` called with `summary` (the stored summary) will do. */
export function describeIntent(toolName: string, summary: Record<string, unknown> | null): Intent {
  const b = new Builder(summary ?? {});
  switch (toolName) {
    case "pinchy_generate_file":
      return generateFile(b);
    case "email_send":
      return email(b, true);
    case "email_draft":
      return email(b, false);
    case "pinchy_write":
      return writeFile(b);
    case "pinchy_delete":
      return deleteFile(b);
    case "odoo_create":
      return odoo(b, "create");
    case "odoo_write":
      return odoo(b, "write");
    case "odoo_delete":
      return odoo(b, "delete");
  }
  const label = TOOL_REGISTRY.find((tool) => tool.id === toolName)?.label;
  if (label) return b.say(label).build(label);
  return b.say("Use the tool ", { code: toolName }).build(`Use the tool ${toolName}`);
}

/** A field name that reads as words once split: `partner_id`, `replyTo`. */
/**
 * A field name that reads as words: lower-case words joined by `_` or `-`
 * (`partner_id`). Written in words it keeps its length — every separator
 * becomes a space, every spelled-out word is as long as it was — so the card
 * draws exactly the characters the summary charged for it (DRAW_BUDGET). A
 * camelCase name (`replyTo`) would gain a space, and stays as it is.
 */
const WORDY_KEY = /^[a-z][a-z0-9]*(?:[_-][a-z0-9]+)*$/;
const SPELLED: ReadonlyMap<string, string> = new Map([
  ["id", "ID"],
  ["ids", "IDs"],
  ["url", "URL"],
  ["vat", "VAT"],
  ["uom", "UoM"],
  ["iban", "IBAN"],
  ["bic", "BIC"],
  ["cc", "CC"],
  ["bcc", "BCC"],
  ["html", "HTML"],
  ["pdf", "PDF"],
  ["csv", "CSV"],
  ["pos", "POS"],
  ["api", "API"],
]);

function humanize(key: string): string {
  const words = key.split(/[_-]/).map((word) => SPELLED.get(word) ?? word);
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(" ");
}

/**
 * The label for each field name, in words where it reads as words (`raw:
 * false`). A name that is quoted or unusual stays as the summary wrote it
 * (`raw: true`), and so do names that two fields would share once written in
 * words — `send_at` and `send-at` are two fields, and must not be two rows
 * labelled alike — or that would read like a label already on the card
 * (`taken`, the sections'). The card draws a raw name in the raw style, so a
 * field `Subject` beside the section "Subject" still reads as a field name.
 */
export function fieldLabels(
  keys: readonly string[],
  taken: readonly string[] = []
): Map<string, { text: string; raw: boolean }> {
  const human = new Map(keys.map((key) => [key, WORDY_KEY.test(key) ? humanize(key) : null]));
  const uses = new Map<string, number>(taken.map((label) => [label, 1]));
  for (const label of human.values()) {
    if (label !== null) uses.set(label, (uses.get(label) ?? 0) + 1);
  }
  return new Map(
    keys.map((key) => {
      const label = human.get(key) ?? null;
      return [
        key,
        label !== null && uses.get(label) === 1
          ? { text: label, raw: false }
          : { text: key, raw: true },
      ];
    })
  );
}

/** `fieldLabels`, as text alone. */
export function humanLabels(
  keys: readonly string[],
  taken: readonly string[] = []
): Map<string, string> {
  return new Map([...fieldLabels(keys, taken)].map(([key, { text }]) => [key, text]));
}
