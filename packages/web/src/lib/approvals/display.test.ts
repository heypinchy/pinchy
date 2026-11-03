import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  FULL_VIEW_KEYS,
  displayScalar,
  inStoredOrder,
  inStoredOrderPlain,
  readNode,
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
    // `model` and `ids` decide which records an Odoo write lands on, so the
    // scan catches id- and model-like names too (`id`, `ids`, `model`, `messageId`, `res_id`, …).
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

describe("readNode", () => {
  it.each([
    [{ "@": "ref", model: "res.partner", id: 7, label: "Acme", labelCut: 0 }],
    [{ "@": "secret", length: 3 }],
    [{ "@": "noted", text: "boss@x.at", notes: [{ kind: "host", host: "xn--x" }] }],
    [
      {
        "@": "noted",
        text: "a@b.at",
        notes: [{ kind: "name", name: "A" }, { kind: "not-a-domain" }],
      },
    ],
    [{ "@": "previewed", text: "abcd", preview: 2, parts: [3, 4], inside: [3] }],
    [
      {
        "@": "noted",
        text: { "@": "previewed", text: "abcd", preview: 2, parts: [4], inside: [] },
        notes: [
          {
            kind: "name",
            name: { "@": "previewed", text: "xyz", preview: 1, parts: [3], inside: [1] },
          },
        ],
      },
    ],
  ])("reads %j as the node it is", (node) => {
    expect(readNode(node)).toBe(node);
  });

  it.each([["text"], [7], [null], [["@"]], [{ to: "a@b.at" }], [{ '"@"': "secret" }]])(
    "reads %j as a plain value",
    (value) => {
      expect(readNode(value)).toBeNull();
    }
  );

  // A row written by a newer version, or garbage: never drawn as fields.
  it.each([
    [{ "@": "chart" }],
    [{ "@": "secret", length: "3" }],
    [{ "@": "ref", model: "x", id: 1.5, label: "y", labelCut: 0 }],
    [{ "@": "noted", text: "a", notes: [] }],
    [{ "@": "noted", text: "a", notes: [{ kind: "host" }] }],
    // No version of Pinchy writes this note.
    [{ "@": "noted", text: "a", notes: [{ kind: "not-a-url" }] }],
    // A previewed text whose cuts don't fit it: nothing is guessed.
    [{ "@": "previewed", text: "abc", preview: 2 }],
    [{ "@": "previewed", text: "abc", preview: 3, parts: [3], inside: [] }],
    [{ "@": "previewed", text: "abc", preview: 2, parts: [2], inside: [] }],
    [{ "@": "previewed", text: "abc", preview: 2, parts: [2, 1, 3], inside: [] }],
    [{ "@": "previewed", text: "abc", preview: 2, parts: [3], inside: [1] }],
    [{ "@": "previewed", text: "a😀c", preview: 2, parts: [4], inside: [] }],
    [{ "@": "noted", text: { "@": "secret", length: 3 }, notes: [{ kind: "host", host: "x" }] }],
    [{ "@": "noted", text: "a", notes: [{ kind: "name", name: { "@": "previewed" } }] }],
  ])("reads %j as unreadable", (value) => {
    expect(readNode(value)).toBe("unreadable");
  });
});

/**
 * With no control character at all, the bidi algorithm draws
 * `/data/חוזים/2024.md` and `/data/2024/חוזים.md` pixel-identically — a digit next to a right-to-left word joins its run — and both
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

  it("puts digits and punctuation that is not strongly right-to-left outside every word", () => {
    // Arabic-Indic digits (an Arabic number, AN) and the Arabic comma (a
    // common separator, CS) take their direction from their neighbours, so
    // neither can join a word and move with it. The Hebrew maqaf and geresh
    // are strongly right-to-left themselves (R), so they belong to the word.
    const text = "عقود١٢،٣ חוזים־א׳ ab";
    for (const line of inStoredOrder(text)!) {
      for (const piece of line) {
        if (piece.word)
          expect(piece.text).toMatch(/^\p{L}[\p{L}\p{M}־׳]*(?: +\p{L}[\p{L}\p{M}־׳]*)*$/u);
      }
    }
    // A Latin word after a space joins the run, as it always has: the space
    // between it and the Hebrew takes the direction of the line, so it stays.
    expect(view(text)).toBe("[عقود]١٢،٣ [חוזים־א׳ ab]");
  });

  // A word of letters and marks only would split the gershayim of בע״מ — in
  // nearly every Israeli company name — into two words, each drawn on its own
  // in stored order: the name would read garbled.
  // Hebrew punctuation is strongly right-to-left (R), like a letter, and a
  // `"` or `'` typed in its place between two right-to-left letters resolves
  // to right-to-left there (UAX #9, N1), so either keeps the word whole and
  // nothing in it can take a neighbour's direction.
  it.each([
    ["חברה בע״מ", "[חברה בע״מ]"],
    ['חברה בע"מ', '[חברה בע"מ]'],
    ["/data/דו״ח רבעוני.pdf", "/data/[דו״ח רבעוני].pdf"],
    ['/data/דו"ח רבעוני.pdf', '/data/[דו"ח רבעוני].pdf'],
    ["/data/ג'ירפה.md", "/data/[ג'ירפה].md"],
    ["/data/ג׳ירפה.md", "/data/[ג׳ירפה].md"],
    ["תל־אביב 2024", "[תל־אביב] 2024"],
    ["פרק א׳", "[פרק א׳]"],
  ])("keeps the Hebrew word %s whole", (text, shown) => {
    expect(view(text)).toBe(shown);
  });

  it.each([
    // Only between two right-to-left letters: next to anything else a quote
    // takes the direction of the text around it, so it stays outside.
    ['a"ב', 'a"[ב]'],
    ['א"b', '[א]"b'],
    ['א"1', '[א]"1'],
    ['1"א', '1"[א]'],
    ['"א"', '"[א]"'],
    ['א" ב', '[א]" [ב]'],
    ['א""ב', '[א]""[ב]'],
    ["א' ב", "[א]' [ב]"],
  ])("keeps a quote in %s outside the word", (text, shown) => {
    expect(view(text)).toBe(shown);
  });

  it("keeps a quote after a letter with its marks", () => {
    expect(view("גּ'ירפה")).toBe("[גּ'ירפה]");
  });

  /*
   * Unicode 16.0, from Python's `unicodedata.bidirectional`, over the blocks
   * `inStoredOrder` treats as right-to-left: every assigned code point that is
   * not a letter, a mark or a format character, split by whether its class is
   * strongly right-to-left (R, AL) or not. Only a strong one may join a word:
   * inside the word's isolate anything weaker would take its direction from a
   * neighbour and could move — a digit next to a word is exactly how
   * `/data/חוזים/2024.md` and `/data/2024/חוזים.md` came to look alike.
   */
  const STRONG_NON_LETTERS = [
    [0x5be, 0x5be],
    [0x5c0, 0x5c0],
    [0x5c3, 0x5c3],
    [0x5c6, 0x5c6],
    [0x5f3, 0x5f4],
    [0x608, 0x608],
    [0x60b, 0x60b],
    [0x60d, 0x60d],
    [0x61b, 0x61b],
    [0x61d, 0x61f],
    [0x66d, 0x66d],
    [0x6d4, 0x6d4],
    [0x6fd, 0x6fe],
    [0x700, 0x70d],
    [0x7c0, 0x7c9],
    [0x7fe, 0x7ff],
    [0x830, 0x83e],
    [0x85e, 0x85e],
    [0x888, 0x888],
    [0xfbb2, 0xfbc2],
    [0xfdfc, 0xfdfc],
    [0x10857, 0x1085f],
    [0x10877, 0x1087f],
    [0x108a7, 0x108af],
    [0x108fb, 0x108ff],
    [0x10916, 0x1091b],
    [0x1093f, 0x1093f],
    [0x109bc, 0x109bd],
    [0x109c0, 0x109cf],
    [0x109d2, 0x109ff],
    [0x10a40, 0x10a48],
    [0x10a50, 0x10a58],
    [0x10a7d, 0x10a7f],
    [0x10a9d, 0x10a9f],
    [0x10ac8, 0x10ac8],
    [0x10aeb, 0x10af6],
    [0x10b58, 0x10b5f],
    [0x10b78, 0x10b7f],
    [0x10b99, 0x10b9c],
    [0x10ba9, 0x10baf],
    [0x10cfa, 0x10cff],
    [0x10d8e, 0x10d8f],
    [0x10ead, 0x10ead],
    [0x10f1d, 0x10f26],
    [0x10f51, 0x10f59],
    [0x10f86, 0x10f89],
    [0x10fc5, 0x10fcb],
    [0x1e8c7, 0x1e8cf],
    [0x1e950, 0x1e959],
    [0x1e95e, 0x1e95f],
    [0x1ec71, 0x1ecb4],
    [0x1ed01, 0x1ed3d],
  ];
  const WEAK_NON_LETTERS = [
    [0x600, 0x607],
    [0x609, 0x60a],
    [0x60c, 0x60c],
    [0x60e, 0x60f],
    [0x660, 0x66c],
    [0x6dd, 0x6de],
    [0x6e9, 0x6e9],
    [0x6f0, 0x6f9],
    [0x7f6, 0x7f9],
    [0x890, 0x891],
    [0x8e2, 0x8e2],
    [0xfb29, 0xfb29],
    [0xfd3e, 0xfd4f],
    [0xfdcf, 0xfdcf],
    [0xfdfd, 0xfdff],
    [0xfeff, 0xfeff],
    [0x1091f, 0x1091f],
    [0x10b39, 0x10b3f],
    [0x10d30, 0x10d39],
    [0x10d40, 0x10d49],
    [0x10d6e, 0x10d6e],
    [0x10e60, 0x10e7e],
    [0x1eef0, 0x1eef1],
  ];
  const each = (ranges: number[][]) =>
    ranges.flatMap(([from, to]) =>
      Array.from({ length: to - from + 1 }, (_, i) => String.fromCodePoint(from + i))
    );

  it("lets every strongly right-to-left non-letter join a word, and nothing weaker", () => {
    const strong = each(STRONG_NON_LETTERS);
    const weak = each(WEAK_NON_LETTERS);
    expect(strong.length).toBeGreaterThan(400);
    expect(weak.length).toBeGreaterThan(100);
    expect(strong.filter((char) => view(`א${char}ב`) !== `[א${char}ב]`)).toEqual([]);
    expect(weak.filter((char) => view(`א${char}ב`) !== `[א]${char}[ב]`)).toEqual([]);
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
