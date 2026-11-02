import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  FULL_VIEW_KEYS,
  displayScalar,
  inStoredOrder,
  inStoredOrderPlain,
  isAddressShaped,
  splitTruncation,
  truncationMarker,
} from "./display";

describe("displayScalar: one rendering per type, so no value passes for another", () => {
  it("renders non-string values as their JSON literal", () => {
    expect(displayScalar(false)).toBe("false");
    expect(displayScalar(1)).toBe("1");
    expect(displayScalar(null)).toBe("null");
  });

  // Odoo reads bool("false") as True, so on a write the two mean opposite
  // things. A string that would read as a literal is shown quoted.
  it.each([
    ["false", '"false"'],
    ["true", '"true"'],
    ["1", '"1"'],
    ["-2.5e3", '"-2.5e3"'],
    ["null", '"null"'],
    ["", '""'],
    ["   ", '"   "'],
    ['"quoted"', '"\\"quoted\\""'],
    ["[1, 2]", '"[1, 2]"'],
    ['{"a":1}', '"{\\"a\\":1}"'],
  ])("quotes the string %j", (value, shown) => {
    expect(displayScalar(value)).toBe(shown);
  });

  it("leaves ordinary text bare", () => {
    expect(displayScalar("Invoice")).toBe("Invoice");
    expect(displayScalar("AT61 1904")).toBe("AT61 1904");
    expect(displayScalar("(empty)")).toBe("(empty)");
  });
});

describe("splitTruncation", () => {
  it("separates the stored truncation marker from the text", () => {
    const text = `${"a".repeat(10)}${truncationMarker(812)}`;
    expect(splitTruncation(text)).toEqual({
      text: "a".repeat(10),
      marker: "… [truncated: 812 more characters not shown]",
    });
  });

  it("leaves text without a marker alone", () => {
    expect(splitTruncation("abc")).toEqual({ text: "abc", marker: null });
  });
});

/**
 * The card never preview-cuts the fields that say WHERE an action lands. Which
 * fields those are is read from the plugins' own tool schemas: every declared
 * parameter whose name says path, file, url, target or destination must be in
 * the set, so a new write tool with such a parameter cannot be shortened on the
 * card unnoticed.
 */
describe("FULL_VIEW_KEYS covers every path- or target-like tool parameter", () => {
  const pluginsDir = resolve(import.meta.dirname, "../../../../plugins");
  const declared = new Set<string>();
  for (const plugin of readdirSync(pluginsDir)) {
    const index = resolve(pluginsDir, plugin, "index.ts");
    if (!existsSync(index)) continue;
    const source = readFileSync(index, "utf8");
    for (const match of source.matchAll(/^\s+([A-Za-z_]+)\s*:\s*\{/gm)) declared.add(match[1]);
  }

  it("found a real corpus of declared parameters", () => {
    expect(declared.size).toBeGreaterThan(40);
    expect(declared).toContain("path");
  });

  it("includes each of them", () => {
    // Third review of #1242: `model` and `ids` decide which records an Odoo
    // write lands on, and were not in the set — the scan now catches id- and
    // model-like names too (`id`, `ids`, `model`, `messageId`, `res_id`, …).
    const targetLike = [...declared].filter(
      (name) =>
        /path|file|url|target|counterpart|destination|model/i.test(name) ||
        /^ids?$|_ids?$|[a-z]Ids?$/.test(name)
    );
    expect(targetLike.length).toBeGreaterThan(3);
    for (const name of targetLike) expect(FULL_VIEW_KEYS, name).toContain(name);
  });

  it("includes the keys that name which record an action lands on", () => {
    for (const key of ["model", "ids", "id", "res_id", "record_id"]) {
      expect(FULL_VIEW_KEYS).toContain(key);
    }
  });

  it("includes every recipient key", () => {
    for (const key of ["to", "cc", "bcc", "from", "reply_to", "recipients"]) {
      expect(FULL_VIEW_KEYS).toContain(key);
    }
  });
});

// Fourth review of #1242: the card shows an address or URL in full at any key,
// so the host at its end is never behind a preview.
describe("isAddressShaped", () => {
  it.each([
    "billing@firma.at",
    "billing@f\u0456rma.at (xn--frma-l9d.at)",
    "https://firma.at/pay",
    "https://evil.com\\@firma.at/x (evil.com)",
  ])("treats %j as an address", (text) => {
    expect(isAddressShaped(text)).toBe(true);
  });

  it.each(["Bitte an billing@firma.at schreiben", "Rechnung Q3", "a@b, c@d"])(
    "treats %j as text",
    (text) => {
      expect(isAddressShaped(text)).toBe(false);
    }
  );
});

/**
 * Eleventh review of #1242: with no control character at all, the bidi
 * algorithm drew `/data/חוזים/2024.md` and `/data/2024/חוזים.md` pixel-
 * identically — a digit next to a right-to-left word joins its run — and both
 * are plain paths. Isolating each `/`-separated segment is not enough:
 * `/data/חוזים-2024.md` and `/data/2024-חוזים.md` collide inside ONE segment.
 *
 * So the card holds everything outside a right-to-left word in stored order
 * (an LTR override), and lets each word keep its own direction in an isolate,
 * where nothing but letters, marks and spaces can sit. Shown that way, a
 * value reads as its pieces in the order they were sent: `[…]` below is a
 * word drawn as one unit.
 */
const view = (text: string) =>
  inStoredOrder(text)
    ?.map((line) => line.map((piece) => (piece.word ? `[${piece.text}]` : piece.text)).join(""))
    .join("\n") ?? text;

describe("inStoredOrder: a value is shown in the order it was sent", () => {
  it.each([
    [
      "/data/חוזים/2024.md",
      "/data/[חוזים]/2024.md",
      "/data/2024/חוזים.md",
      "/data/2024/[חוזים].md",
    ],
    ["/data/عقود/2024.md", "/data/[عقود]/2024.md", "/data/2024/عقود.md", "/data/2024/[عقود].md"],
    ["/data/א/1.md", "/data/[א]/1.md", "/data/1/א.md", "/data/1/[א].md"],
    [
      "/data/חוזים-2024.md",
      "/data/[חוזים]-2024.md",
      "/data/2024-חוזים.md",
      "/data/2024-[חוזים].md",
    ],
  ])("keeps %s apart from its reordered twin", (a, shownA, b, shownB) => {
    expect(view(a)).toBe(shownA);
    expect(view(b)).toBe(shownB);
  });

  it("keeps a run of right-to-left words together, so a sentence still reads", () => {
    expect(view("שלום עולם 2024")).toBe("[שלום עולם] 2024");
  });

  it("puts digits, punctuation and right-to-left non-letters outside every word", () => {
    // Arabic-Indic digits, the Hebrew maqaf and geresh, the Arabic comma: none
    // is a letter, so none can join a word and move with it.
    const text = "عقود١٢،٣ חוזים־א׳ ab";
    for (const line of inStoredOrder(text)!) {
      for (const piece of line) {
        if (piece.word)
          expect(piece.text).toMatch(/^\p{L}[\p{L}\p{M}]*(?: +\p{L}[\p{L}\p{M}]*)*$/u);
      }
    }
    expect(view(text)).toBe("[عقود]١٢،٣ [חוזים]־[א]׳ ab");
  });

  it("keeps a mark on the letter it belongs to", () => {
    expect(view("שָׁלוֹם/1")).toBe("[שָׁלוֹם]/1");
  });

  // A line break ends every override and isolate (it is a paragraph
  // separator), so each line is held in order on its own.
  it("holds every line in order", () => {
    expect(inStoredOrder("a/חוזים\n2024/ב")).toEqual([
      [
        { text: "a/", word: false },
        { text: "חוזים", word: true },
      ],
      [
        { text: "2024/", word: false },
        { text: "ב", word: true },
      ],
    ]);
  });

  // Nothing in such a text can be reordered: it has no right-to-left letter,
  // no right-to-left mark and no Arabic digit (the four bidi controls that
  // are right-to-left too are shown as ⟨U+XXXX⟩ markers by the summary).
  it("leaves a text without a right-to-left character as it is", () => {
    expect(inStoredOrder("/data/2024/Grüße 東京.md")).toBeNull();
  });

  it("writes the same order into plain text, for the chat-channel prompt", () => {
    expect(inStoredOrderPlain("/data/חוזים/2024.md")).toBe(
      "\u2066\u202D/data/\u2066חוזים\u2069/2024.md\u202C\u2069"
    );
    expect(inStoredOrderPlain("a/א\nb")).toBe(
      "\u2066\u202Da/\u2066א\u2069\u202C\u2069\n\u2066\u202Db\u202C\u2069"
    );
    expect(inStoredOrderPlain("/data/2024/x.md")).toBe("/data/2024/x.md");
  });
});
