import { describe, it, expect } from "vitest";
import {
  PREVIEW_LEN,
  WHOLE_MAX,
  displayScalar,
  drawCost,
  drawnOf,
  partOf,
  previewOf,
  readNode,
  type Previewed,
  type TextWindow,
} from "./display";
import {
  isAddressShaped,
  mailboxAddress,
  previewed,
  readUrl,
  shownAs,
  urlHostAsWritten,
} from "./presentation";
import browserUrlHosts from "./browser-url-hosts.json";

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

// Where Node's parser refuses a URL, the host is read off the text the way a
// browser reads it: Chromium and WebKit open `https://xn--a.evil.com/x y`,
// `ht\ttps://xn--a.evil.com/` and the rest. Checked against the hosts the
// browsers themselves resolve (`scripts/generate-browser-url-hosts.mjs`), not
// against a reading of the spec. A host Chromium only percent-escapes
// (`evil.com%20see%20above`) is no name DNS can look up: it reaches nothing.
describe("urlHostAsWritten", () => {
  const refused = browserUrlHosts.rows.filter((row) => row.node === null);

  it.each(refused)("reads $text as a browser does", (row) => {
    const reached = [row.chromium, row.webkit].filter(
      (host): host is string => !!host && !host.includes("%")
    );
    const host = urlHostAsWritten(row.text)?.toLowerCase() ?? null;
    if (reached.length === 0) expect(host).toBeNull();
    else expect(reached).toContain(host);
  });

  it("covers both answers", () => {
    const opened = refused.filter((row) => urlHostAsWritten(row.text) !== null);
    expect(opened.length).toBeGreaterThan(50);
    expect(refused.length - opened.length).toBeGreaterThan(30);
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

// An address or URL is drawn whole at any key, so the host at its end is
// never behind a preview.
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

// One answer to "is this value previewed?", which decides both what the card
// draws and when a value's host has to be named beside it. It is asked of the
// text as stored — markers included — and counted as drawn: quoted where it
// would read as a literal.
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

/** `text` as the summary stores a long text: previewed, with every cut the card makes. */
function nodeOf(text: string): Previewed {
  const shown = shownAs(text, false);
  if (typeof shown === "string") throw new Error(`drawn whole: ${text.slice(0, 40)}`);
  return shown;
}

/** Every part "Show full text" reveals of `text`, in order, as the summary cut them. */
function partsOf(text: string): TextWindow[] {
  const node = nodeOf(text);
  return node.parts.map((_, index) => partOf(node, index));
}

/** What the collapsed card draws of `text`, as a value under an ordinary key. */
function drawnText(text: string): string {
  return drawnOf(shownAs(text, false));
}

/** Does the preview of `text` end inside one character, by the summary's cut? */
function previewEndsInside(text: string): boolean {
  const shown = shownAs(text, false);
  return typeof shown !== "string" && previewOf(shown).endsInside;
}

/**
 * Drawn whole, a 200,000-character value blocked Chromium for 13–28 s on
 * "Show full text", and again on every relayout. So the card reveals a long
 * text one part at a time, each part bounded by the rule that bounds a whole
 * target: its characters cost at most WHOLE_MAX (`drawCost`).
 */
describe("shownAs: a long text revealed in parts, each one bounded", () => {
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
    expect(partsOf(text)).toEqual([
      expect.objectContaining({ start: 0, end: text.length, drawn: text }),
    ]);
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
describe("shownAs: a part boundary changes nothing about how either side is drawn", () => {
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

describe("shownAs: a preview ends between two characters as read", () => {
  it.each([
    ["a letter and its accent", `${"x".repeat(199)}é und mehr ${"y".repeat(300)}`],
    ["a flag", `${"x".repeat(199)}🇦🇹 ${"y".repeat(300)}`],
    ["a marker", `${"x".repeat(197)}⟨U+200D⟩ ${"y".repeat(300)}`],
  ])("never ends inside %s", (_name, text) => {
    expect(drawnText(text)).toBe(text.slice(0, text.search(/[^x]/u)));
  });
});

describe("shownAs: a preview cut inside one character says so", () => {
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

describe("shownAs: every cut the card makes, stored in the node", () => {
  it("draws a short text, or a target or address up to WHOLE_MAX, whole", () => {
    expect(shownAs("x".repeat(PREVIEW_LEN), false)).toBe("x".repeat(PREVIEW_LEN));
    expect(shownAs("x".repeat(WHOLE_MAX), true)).toBe("x".repeat(WHOLE_MAX));
    const address = `https://firma.at/${"a".repeat(1_000)}`;
    expect(shownAs(address, false)).toBe(address);
  });

  // `"1" × 199` reads as a number, so it is drawn quoted: 201 characters, of
  // which a preview would hide only the closing quote.
  it("draws a text whole when its preview would hold all of it", () => {
    const text = "1".repeat(PREVIEW_LEN - 1);
    expect([...displayScalar(text)]).toHaveLength(PREVIEW_LEN + 1);
    expect(shownAs(text, false)).toBe(text);
  });

  it("previews a text that reads as a literal by its escapes, never cutting inside one", () => {
    const text = `[${Array(100).fill('"\u{1F600}"').join(",")}]`;
    const node = nodeOf(text);
    const drawn = drawnOf(node);
    expect([...drawn].length).toBeLessThanOrEqual(PREVIEW_LEN);
    expect(drawn.startsWith('"')).toBe(true);
    expect(JSON.parse(`${drawn}"`)).toBe(text.slice(0, node.preview));
  });

  it("pairs every flag's indicators across many parts", () => {
    const text = `a${"\u{1F1E6}\u{1F1F9}\u{1F1E9}\u{1F1EA}\u{1F1FA}\u{1F1F8}".repeat(400)}`;
    const parts = partsOf(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.flatMap((part) => flagsOf(text.slice(part.start, part.end)))).toEqual(
      flagsOf(text)
    );
  });

  // The card validates a node before it draws one (`readNode`), and draws
  // none it cannot read: every node the summary writes must pass.
  it("writes nodes the card reads, on generated texts", () => {
    const next = seeded(1_242_022);
    for (let round = 0; round < 30; round++) {
      const node = nodeOf(generatedText(next));
      expect(readNode(node)).toBe(node);
      expect(node.parts.at(-1)).toBe(node.text.length);
      expect(node.inside.every((at) => at === node.preview || node.parts.includes(at))).toBe(true);
    }
  });
});

// Where a character begins is read once, front to back. Asked per offset, a
// run of regional indicators is walked back to its start on every question —
// whether two indicators are a flag depends on how many stand before them —
// and the summary of one 200,000-character value took seconds of the server's
// one event loop, for every user at once.
describe("shownAs: time grows with the text, not with its square", () => {
  const indicators = (count: number) =>
    Array.from({ length: count }, (_, i) => String.fromCodePoint(0x1f1e6 + (i % 26))).join("");

  it("cuts 200,000 characters of one run of regional indicators in well under a second", () => {
    const text = `${"a".repeat(100)}${indicators(199_900)}`;
    shownAs(text, false);
    const started = performance.now();
    const node = shownAs(text, false) as Previewed;
    const elapsed = performance.now() - started;
    expect(node.parts.at(-1)).toBe(text.length);
    expect(readNode(node)).toBe(node);
    // Linear, this takes tens of milliseconds; the bound leaves room for a
    // loaded machine and still fails the per-offset walk, which takes 1.9 s.
    expect(elapsed).toBeLessThan(600);
  });
});
