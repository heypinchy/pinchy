// @vitest-environment node
import { describe, it, expect } from "vitest";
import { contextualJoinerOffsets, invisibleFormatOffsets, isVirama } from "./emoji-sequence";

/**
 * Canonical_Combining_Class = 9 (Virama) in Unicode 16.0, as Python's
 * `unicodedata.combining()` lists it. JavaScript has no `\p{ccc=…}`, so the
 * module derives the set from canonical ordering at run time; this pins the
 * derivation to the published table. A later Unicode in Node may add to it —
 * so "at least these" — but must never lose one.
 */
const UNICODE_16_VIRAMAS = [
  0x94d, 0x9cd, 0xa4d, 0xacd, 0xb4d, 0xbcd, 0xc4d, 0xccd, 0xd3b, 0xd3c, 0xd4d, 0xdca, 0xe3a, 0xeba,
  0xf84, 0x1039, 0x103a, 0x1714, 0x1715, 0x1734, 0x17d2, 0x1a60, 0x1b44, 0x1baa, 0x1bab, 0x1bf2,
  0x1bf3, 0x2d7f, 0xa806, 0xa82c, 0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed, 0x10a3f, 0x11046, 0x11070,
  0x1107f, 0x110b9, 0x11133, 0x11134, 0x111c0, 0x11235, 0x112ea, 0x1134d, 0x113ce, 0x113cf, 0x113d0,
  0x11442, 0x114c2, 0x115bf, 0x1163f, 0x116b6, 0x1172b, 0x11839, 0x1193d, 0x1193e, 0x119e0, 0x11a34,
  0x11a47, 0x11a99, 0x11c3f, 0x11d44, 0x11d45, 0x11d97, 0x11f41, 0x11f42, 0x1612f,
];

describe("isVirama", () => {
  it("knows every virama of Unicode 16.0", () => {
    const missing = UNICODE_16_VIRAMAS.filter((cp) => !isVirama(String.fromCodePoint(cp)));
    expect(missing.map((cp) => cp.toString(16))).toEqual([]);
  });

  it("names nothing but viramas", () => {
    const found: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (isVirama(String.fromCodePoint(cp))) found.push(cp);
    }
    // Every one it finds is a combining mark of a Brahmic (or similar)
    // script — and the two reference marks the derivation measures against
    // (U+3099, class 8; U+05B0, class 10) are not among them.
    expect(found.every((cp) => /^\p{M}$/u.test(String.fromCodePoint(cp)))).toBe(true);
    expect(found).not.toContain(0x3099);
    expect(found).not.toContain(0x05b0);
    // Nukta (class 7) and an ordinary vowel sign (class 0) are not viramas.
    expect(found).not.toContain(0x093c);
    expect(found).not.toContain(0x0941);
    expect(found.length).toBeGreaterThanOrEqual(UNICODE_16_VIRAMAS.length);
  });
});

describe("contextualJoinerOffsets (RFC 5892 CONTEXTJ)", () => {
  const offsetsOf = (text: string) => [...contextualJoinerOffsets(text)];

  it.each([
    ["ZWNJ after a virama", "क्\u200Cष", 2],
    ["ZWJ after a virama", "ශ්\u200Dරී", 2],
    ["ZWNJ between two dual-joining letters", "گزارش\u200Cها", 5],
    ["ZWNJ between a dual- and a right-joining letter", "علی\u200Cرضا", 3],
    ["ZWNJ with vowel marks on either side", "مِ\u200Cِه", 2],
  ])("allows %s", (_label, text, offset) => {
    expect(offsetsOf(text)).toEqual([offset]);
  });

  it.each([
    ["ZWNJ between Latin letters", "a\u200Cb"],
    ["ZWJ between Latin letters", "a\u200Db"],
    ["ZWNJ after a right-joining letter", "محمد\u200Cرضا"],
    ["ZWNJ before a non-joining letter", "ش\u200Cء"],
    ["ZWNJ at the end", "گزارش\u200C"],
    ["ZWNJ at the start", "\u200Cها"],
    ["ZWJ between Arabic letters", "ش\u200Dه"],
    ["ZWNJ between an Arabic and a Latin letter", "ش\u200Ca"],
    ["ZWNJ after a nukta", "क\u093C\u200Cष"],
  ])("refuses %s", (_label, text) => {
    expect(offsetsOf(text)).toEqual([]);
  });
});

describe("invisibleFormatOffsets", () => {
  it("counts a joiner as invisible unless it is in an emoji or shapes the text", () => {
    const text = "a\u200Cb \u{1F468}\u200D\u{1F469} ශ්\u200Dරී x\u200Dy";
    const invisible = [...invisibleFormatOffsets(text, { redundant: false })];
    expect(invisible.map((offset) => text.codePointAt(offset)!.toString(16))).toEqual([
      "200c",
      "200d",
    ]);
    expect(invisible).toEqual([1, text.lastIndexOf("\u200D")]);
  });
});
