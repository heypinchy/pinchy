import { afterEach, describe, it, expect, vi } from "vitest";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  FULL_VIEW_KEYS,
  WHOLE_MAX,
  displayScalar,
  drawCost,
  drawnText,
  inStoredOrder,
  inStoredOrderPlain,
  isAddressShaped,
  mailboxAddress,
  previewEndsInside,
  previewed,
  readNode,
  readUrl,
  textWindow,
  type TextWindow,
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

// A URL is what the parser the tool uses accepts, read the way that parser
// reads it.
describe("readUrl", () => {
  it.each([
    ["https://firma.at/pay", "firma.at", true],
    ["https://Firma.at:8443/pay", "firma.at", true],
    ["http://[::1]:8080/", "[::1]", true],
    ["https:f\u0456rma.at/x", "xn--frma-l9d.at", false],
    ["https:/firma.at/x", "firma.at", false],
    ["https:\\\\firma.at\\x", "firma.at", false],
    ["https://fir%6Da.at/", "firma.at", false],
    ["https://firma.at@evil.com/", "evil.com", false],
    ["https://firma.at:pw@firma.at/", "firma.at", false],
    ["https://evil.com\\@firma.at/x", "evil.com", false],
    ["\u0001 https://firma.at/x", "firma.at", true],
  ])("reads %j as reaching %s (host shown: %s)", (text, host, showsHost) => {
    expect(readUrl(text)).toMatchObject({ host, showsHost });
  });

  it.each([
    "https://firma.at\nHi team",
    "https://firma.at — new site is live",
    "https://firma.at, see above",
    "mailto:boss@firma.at",
    "urn:isbn:0451450523",
    "Rechnung Q3",
    "",
  ])("does not read %j as a URL the tools fetch", (text) => {
    expect(readUrl(text)).toBeNull();
  });

  it("tells one token from a URL followed by more text", () => {
    expect(readUrl("https://firma.at/x")?.oneToken).toBe(true);
    expect(readUrl("  https://firma.at/x ")?.oneToken).toBe(true);
    expect(readUrl("https://firma.at/ is live")?.oneToken).toBe(false);
  });
});

describe("mailboxAddress", () => {
  it.each([
    ["boss@firma.at", "boss@firma.at"],
    ["  boss@firma.at\n", "boss@firma.at"],
    ["Boss <boss@firma.at>", "boss@firma.at"],
    ['"Huber, Boss" <boss@firma.at>', "boss@firma.at"],
  ])("reads %j as the address %s", (text, address) => {
    expect(mailboxAddress(text)).toBe(address);
  });

  it.each([
    "Bitte an boss@firma.at schreiben",
    "a@b.at, c@d.at",
    "Huber, Boss <boss@firma.at>",
    "boss@firma.at <attacker@evil.com>",
    "Hi\nteam <boss@firma.at>",
  ])("does not read %j as one address", (text) => {
    expect(mailboxAddress(text)).toBeNull();
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

// The card shows an address or URL in full at any key,
// so the host at its end is never behind a preview.
describe("isAddressShaped", () => {
  it.each([
    "billing@firma.at",
    "billing@f\u0456rma.at",
    "https://firma.at/pay",
    "https://evil.com\\@firma.at/x",
    // What the URL parser and the mail tool accept.
    "https:firma.at/x",
    "\u0001https://f\u0456rma.at/x",
    " boss@firma.at",
    "Boss <boss@f\u0456rma.at>",
  ])("treats %j as an address", (text) => {
    expect(isAddressShaped(text)).toBe(true);
  });

  // The host note is a node of its own, never text after the address, so an
  // address with a note TYPED after it is text: stripping a trailing " (…)"
  // first would read it as an address with Pinchy's note.
  it.each([
    "Bitte an billing@firma.at schreiben",
    "Rechnung Q3",
    "a@b, c@d",
    "billing@f\u0456rma.at (xn--frma-l9d.at)",
    "billing@f\u0456rma.at (firma.at)",
    // Free text that begins with a URL is drawn as text, previewed like any
    // other.
    "https://firma.at\nHi team, the new site is live.",
    "https://firma.at — new site is live",
    "https://firma.at, see above",
    "https://firma.at/ is live",
  ])("treats %j as text", (text) => {
    expect(isAddressShaped(text)).toBe(false);
  });
});

// One answer to "does the card cut this value to a preview?", read by the
// card to draw it and by the summary to decide when a value's host has to be
// named beside it. It is asked of the text as stored — markers included — and
// counted as drawn: quoted where it would read as a literal.
describe("previewed", () => {
  it("previews long text, and draws short text whole", () => {
    expect(previewed("x".repeat(200), false)).toBe(false);
    expect(previewed("x".repeat(201), false)).toBe(true);
  });

  it("draws a target, a recipient or an address whole up to 8,192 characters", () => {
    expect(previewed("x".repeat(8_192), true)).toBe(false);
    expect(previewed("x".repeat(8_193), true)).toBe(true);
    expect(previewed(`a@${"b".repeat(8_187)}.at`, false)).toBe(false);
  });

  it("counts the quotes a text that reads as a literal is drawn with", () => {
    const literal = `"${"a".repeat(8_179)}@firma.at"`;
    expect([...literal]).toHaveLength(8_190);
    expect(previewed(literal, true)).toBe(true);
  });

  it("reads the stored text, where a run of hidden characters is a marker with spaces in it", () => {
    expect(previewed(`https://firma.at/${"a".repeat(200)}⟨4 × U+200B⟩`, false)).toBe(true);
    expect(previewed(`https://firma.at/${"a".repeat(200)}⟨U+200B⟩`, false)).toBe(false);
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

/** Every part "Show full text" reveals of `text`, in order. */
function partsOf(text: string, window: typeof textWindow = textWindow): TextWindow[] {
  const parts = [window(text, 0)];
  while (parts.at(-1)!.end < text.length) parts.push(window(text, parts.at(-1)!.end));
  return parts;
}

/**
 * Drawn whole, a 200,000-character value blocked Chromium for 13–28 s on
 * "Show full text", and again on every relayout. So the card reveals a long
 * text one part at a time, each part bounded by the rule that bounds a whole
 * target: its characters cost at most WHOLE_MAX (`drawCost`).
 */
describe("textWindow: a long text revealed in parts, each one bounded", () => {
  const texts: [string, string][] = [
    ["alternating Hebrew letters and digits", "\u05d01".repeat(100_000)],
    ["emoji between letters", `${"a".repeat(200)}${"\u{1F3F3}x".repeat(30_000)}`],
    ["a letter carrying 20,000 marks", `a${"\u0301".repeat(20_000)}`],
    ["markers", `x${"⟨U+2800⟩".repeat(3_000)}`],
    ["flags", `a${"\u{1F1E6}\u{1F1F9}".repeat(2_000)}`],
    ["accented letters", `a${"e\u0301".repeat(10_000)}`],
    ["a text that reads as a literal", JSON.stringify(Array(3_000).fill('he said "hi" \\ ok'))],
  ];

  it.each(texts)("costs at most WHOLE_MAX to draw per part: %s", (_name, text) => {
    const parts = partsOf(text);
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.end).toBeGreaterThan(part.start);
      expect(drawCost(part.drawn)).toBeLessThanOrEqual(WHOLE_MAX + 1);
    }
  });

  it.each(texts)("draws every character, in order, across its parts: %s", (_name, text) => {
    const parts = partsOf(text);
    expect(parts.map((part) => part.drawn).join("")).toBe(displayScalar(text));
    expect(parts.map((part) => text.slice(part.start, part.end)).join("")).toBe(text);
    parts.forEach((part, index) => {
      expect(part.start).toBe(index === 0 ? 0 : parts[index - 1].end);
    });
  });

  it.each(texts)("counts the parts in characters as drawn: %s", (_name, text) => {
    const parts = partsOf(text);
    const total = [...displayScalar(text)].length;
    let first = 1;
    for (const part of parts) {
      expect(part).toMatchObject({ first, last: first + [...part.drawn].length - 1, total });
      first = part.last + 1;
    }
    expect(parts.at(-1)!.last).toBe(total);
  });

  it("draws a text that fits in one part whole", () => {
    const text = "x".repeat(WHOLE_MAX);
    expect(textWindow(text, 0)).toMatchObject({ start: 0, end: text.length, drawn: text });
  });

  it("never ends a part inside a character, an emoji flag or a letter with its accent", () => {
    for (const text of [
      `a${"\u{1F1E6}\u{1F1F9}".repeat(2_000)}`,
      `a${"e\u0301".repeat(10_000)}`,
      `a${"😀".repeat(2_000)}`,
    ]) {
      for (const part of partsOf(text).slice(1)) {
        const head = text.slice(part.start);
        expect(head).not.toMatch(/^[\p{M}\uDC00-\uDFFF]/u);
        // A flag is a pair of regional indicators: a part starts on the first.
        const indicators = [...text.slice(0, part.start)].filter((char) =>
          /\p{Regional_Indicator}/u.test(char)
        );
        expect(indicators.length % 2).toBe(0);
      }
    }
  });

  it("splits one character too long to draw at once between its code points", () => {
    const text = `a${"\u0301".repeat(20_000)}`;
    const parts = partsOf(text);
    expect(parts.length).toBeGreaterThan(2);
    expect(parts.map((part) => part.drawn).join("")).toBe(text);
  });

  // Every `⟨` opens a marker Pinchy wrote; a part that ended inside one would
  // draw `⟨U+28` and start the next with `00⟩`, neither of them a marker.
  it("never ends a part inside a marker", () => {
    for (const text of [`x${"⟨U+2800⟩".repeat(3_000)}`, `xy${"⟨12 × U+2800⟩".repeat(1_000)}`]) {
      for (const part of partsOf(text)) {
        expect(part.drawn).toMatch(/^(?:x|y|⟨[^⟨⟩]*⟩)+$/u);
      }
    }
  });

  // A text that reads as a literal is drawn quoted and escaped. A part that
  // ended between `\` and the `"` it escapes would draw a lone backslash and
  // start the next part with a bare quote.
  it("never ends a part inside an escape of a text drawn quoted", () => {
    const text = JSON.stringify(Array(3_000).fill('he said "hi" \\ ok'));
    const parts = partsOf(text);
    parts.forEach((part, index) => {
      const open = index === 0 ? '"' : "";
      const close = index === parts.length - 1 ? '"' : "";
      expect(part.drawn.startsWith(open) && part.drawn.endsWith(close)).toBe(true);
      const inner = part.drawn.slice(open.length, part.drawn.length - close.length);
      expect(JSON.parse(`"${inner}"`)).toBe(text.slice(part.start, part.end));
    });
  });
});

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: "grapheme" });

/** The characters `text` draws as a person reads them (grapheme clusters), drawn on its own. */
function clustersOf(text: string): string[] {
  return [...GRAPHEMES.segment(text)].map(({ segment }) => segment);
}

/** Where the characters of `text`, read whole, begin: and its end. */
function boundariesOf(text: string): Set<number> {
  return new Set([...[...GRAPHEMES.segment(text)].map(({ index }) => index), text.length]);
}

/**
 * The flags `text` draws, drawn on its own: the regional indicators of each
 * character as letters (`🇦🇹` is "AT"). A browser pairs them from the start of
 * their run, so one indicator too many in front pairs every later one wrongly.
 */
function flagsOf(text: string): string[] {
  return clustersOf(text)
    .map((cluster) =>
      [...cluster]
        .filter((char) => /\p{Regional_Indicator}/u.test(char))
        .map((char) => String.fromCharCode(char.codePointAt(0)! - 0x1f1e6 + 65))
        .join("")
    )
    .filter(Boolean);
}

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
 * Pieces whose drawing depends on what stands beside them: regional
 * indicators (paired from the start of their run), a ZWJ sequence, an emoji
 * and its skin tone, a letter and its accent, a stray mark, Hangul jamo
 * (L, V, T), a Malayalam dot reph (it prepends to what follows), a Devanagari
 * conjunct and its halves, Arabic letters that join, and the plain text,
 * spaces, line breaks and markers between them.
 */
const PIECES = [
  "\u{1F1E6}",
  "\u{1F1F9}",
  "\u{1F1E9}",
  "\u{1F1EA}",
  "\u{1F469}‍\u{1F4BB}",
  "\u{1F44D}\u{1F3FD}",
  "é",
  "̣",
  "ᄀ",
  "ᅡ",
  "ᆨ",
  "각",
  "ൎ",
  "क्ष",
  "क्",
  "ष",
  "مرحبا",
  " ",
  "\n",
  "x",
  "⟨U+200D⟩",
  "\u{1F600}",
  "\u{20000}",
];

/** Runs of one piece long enough that one character alone costs more than a part. */
const LONG_RUNS = [
  () => `a${"́".repeat(9_000)}`,
  () => `${"ൎ".repeat(8_100)}\u{1F1E6}\u{1F1F9}`,
  () => `${"ᄀ".repeat(9_000)}ᅡᆨ`,
  () => "क्".repeat(4_200),
];

/** A text of a few parts, mixing every piece above, sometimes with a long run. */
function generatedText(next: () => number): string {
  const length = 3_000 + Math.floor(next() * 25_000);
  let text = "";
  while (text.length < length) {
    if (next() < 0.002) text += LONG_RUNS[Math.floor(next() * LONG_RUNS.length)]();
    const piece = PIECES[Math.floor(next() * PIECES.length)];
    text += piece.repeat(1 + Math.floor(next() * 4));
  }
  return text;
}

/**
 * A part boundary changes nothing about how the text on either side of it is
 * drawn: each part draws exactly the characters the whole text draws there.
 * Cut between the two regional indicators of a flag, the next part paired
 * every later indicator with the wrong partner: 🇦🇹🇩🇪🇺🇸 read 🇹🇩 (Chad), 🇪🇺,
 * "S" — flags the value does not contain.
 */
describe("textWindow: a part boundary changes nothing about how either side is drawn", () => {
  it("pairs a flag's indicators as the whole text does, after a character too long for one part", () => {
    // A dot reph prepends to whatever follows (UAX #29 GB9b): 7,980 of them
    // and the first flag are one character, costlier than a part.
    const text = `Grüße an die Teams ${"ൎ".repeat(7_980)}🇦🇹🇩🇪🇺🇸`;
    const parts = partsOf(text);
    expect(parts.flatMap((part) => flagsOf(text.slice(part.start, part.end)))).toEqual([
      "AT",
      "DE",
      "US",
    ]);
  });

  it("ends a part after a space where one fits, so no word is shaped differently", () => {
    // Arabic letters join: cut inside a word, its letters take the forms they
    // have at the end and the start of one.
    for (const text of ["مرحبا بالعالم ".repeat(1_500), "क्षत्रिय नमस्ते ".repeat(1_500)]) {
      const parts = partsOf(text);
      expect(parts.length).toBeGreaterThan(1);
      for (const part of parts.slice(0, -1)) expect(text[part.end - 1]).toBe(" ");
    }
  });

  it("splits only a character too long for one part, and says so on both sides of the cut", () => {
    const text = `ok ${"a" + "́".repeat(9_000)} ok`;
    const parts = partsOf(text);
    const split = parts.findIndex((part) => part.endsInside);
    expect(split).toBeGreaterThanOrEqual(0);
    expect(parts[split + 1].startsInside).toBe(true);
    expect(partsOf(`${"a".repeat(WHOLE_MAX)}SECOND`)).toEqual([
      expect.objectContaining({ startsInside: false, endsInside: false }),
      expect.objectContaining({ startsInside: false, endsInside: false }),
    ]);
  });

  it("holds on generated texts of flags, joiners, marks, jamo, conjuncts and prepended runs", () => {
    const next = seeded(1242);
    for (let round = 0; round < 60; round++) {
      const text = generatedText(next);
      const whole = boundariesOf(text);
      const parts = partsOf(text);
      expect(parts.map((part) => part.drawn).join("")).toBe(displayScalar(text));
      expect(parts.flatMap((part) => flagsOf(text.slice(part.start, part.end)))).toEqual(
        flagsOf(text)
      );
      parts.forEach((part, index) => {
        expect(drawCost(part.drawn)).toBeLessThanOrEqual(WHOLE_MAX + 1);
        // Where it says it isn't, the cut is inside one character of the
        // whole text, and only one that alone costs more than a part.
        expect(part.startsInside).toBe(index > 0 && !whole.has(part.start));
        expect(part.endsInside).toBe(part.end < text.length && !whole.has(part.end));
        if (part.endsInside) {
          const inside = [...whole].filter((at) => at > part.start && at < part.end);
          expect(inside).toEqual([]);
        }
        // Every character of the whole text inside the part, the part draws
        // whole and alone: where the whole text has a boundary, so does the
        // part drawn on its own, and nowhere else.
        const own = boundariesOf(text.slice(part.start, part.end));
        const edges = [...whole].filter((at) => at >= part.start && at <= part.end);
        const differ: number[] = [];
        for (let at = Math.min(...edges); at <= Math.max(...edges); at++) {
          if (own.has(at - part.start) !== whole.has(at)) differ.push(at);
        }
        expect(differ).toEqual([]);
      });
    }
  });
});

describe("drawnText: a preview ends between two characters as read", () => {
  it.each([
    ["a letter and its accent", `${"x".repeat(199)}é und mehr ${"y".repeat(300)}`],
    ["a flag", `${"x".repeat(199)}🇦🇹 ${"y".repeat(300)}`],
    ["a marker", `${"x".repeat(197)}⟨U+200D⟩ ${"y".repeat(300)}`],
  ])("never ends inside %s", (_name, text) => {
    expect(drawnText(text, false)).toBe(text.slice(0, text.search(/[^x]/u)));
  });
});

describe("previewEndsInside: a preview cut inside one character says so", () => {
  it.each([
    ["a letter under more accents than a preview holds", `a${"\u0301".repeat(300)} ok`, true],
    ["an emoji under more skin tones than a preview holds", `👍${"🏽".repeat(250)}`, true],
    ["a cut between two letters", `${"a".repeat(200)}SECRET-TAIL`, false],
    [
      "a cut back to a letter and its accent",
      `${"x".repeat(199)}e\u0301 und ${"y".repeat(300)}`,
      false,
    ],
    ["a text the preview holds whole", "kurz", false],
  ])("%s", (_name, text, inside) => {
    expect(previewEndsInside(text)).toBe(inside);
  });
});

/** `display.ts` as a browser without Intl.Segmenter (Firefox before 125) loads it. */
async function withoutSegmenter(): Promise<typeof import("./display")> {
  vi.resetModules();
  vi.stubGlobal("Intl", Object.create(Intl, { Segmenter: { value: undefined } }));
  try {
    return await import("./display");
  } finally {
    vi.unstubAllGlobals();
  }
}

describe("textWindow without Intl.Segmenter", () => {
  afterEach(() => vi.resetModules());

  it("pairs every flag's indicators as the whole text does", async () => {
    const { textWindow: window } = await withoutSegmenter();
    for (const text of [
      `a${"🇦🇹🇩🇪🇺🇸".repeat(400)}`,
      `Grüße an die Teams ${"ൎ".repeat(7_980)}🇦🇹🇩🇪🇺🇸`,
    ]) {
      const parts = partsOf(text, window);
      expect(parts.length).toBeGreaterThan(1);
      expect(parts.flatMap((part) => flagsOf(text.slice(part.start, part.end)))).toEqual(
        flagsOf(text)
      );
    }
  });

  it("says where it cannot tell that a cut falls between two characters", async () => {
    const { textWindow: window } = await withoutSegmenter();
    const next = seeded(125);
    for (let round = 0; round < 20; round++) {
      const text = generatedText(next);
      const whole = boundariesOf(text);
      const parts = partsOf(text, window);
      expect(parts.map((part) => part.drawn).join("")).toBe(displayScalar(text));
      expect(parts.flatMap((part) => flagsOf(text.slice(part.start, part.end)))).toEqual(
        flagsOf(text)
      );
      parts.forEach((part, index) => {
        // Bounded by the same count with or without it: a cut it cannot place
        // only ever ends a part earlier.
        expect(drawCost(part.drawn)).toBeLessThanOrEqual(WHOLE_MAX + 1);
        if (!part.endsInside) expect(part.end === text.length || whole.has(part.end)).toBe(true);
        if (index > 0) expect(part.startsInside).toBe(parts[index - 1].endsInside);
      });
    }
  });

  it("cuts a preview between two characters as read", async () => {
    const { drawnText: preview } = await withoutSegmenter();
    expect(preview(`${"x".repeat(199)}é und mehr ${"y".repeat(300)}`, false)).toBe("x".repeat(199));
    expect(preview(`${"x".repeat(199)}🇦🇹 ${"y".repeat(300)}`, false)).toBe("x".repeat(199));
  });

  it("says where it cannot tell that a preview ends between two characters", async () => {
    const { previewEndsInside: endsInside } = await withoutSegmenter();
    // One character as read: it cannot see where the skin tones end.
    expect(endsInside(`\u00e9👍${"🏽".repeat(250)}`)).toBe(true);
    expect(endsInside(`${"x".repeat(199)}e\u0301 und mehr ${"y".repeat(300)}`)).toBe(false);
  });
});
