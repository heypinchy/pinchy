// @vitest-environment node
import { describe, it, expect } from "vitest";
import {
  contextualJoinerOffsets,
  invisibleFormatOffsets,
  isVirama,
  viramaScript,
} from "./emoji-sequence";

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

// A joiner after a virama shapes text only within the virama's own script, so
// the module has to know that script. JavaScript cannot ask a character for
// its script, only test it against a named one, so the names are listed — and
// a virama whose script is missing from the list would refuse every joiner
// after it, which is why the list is pinned to every virama.
describe("viramaScript", () => {
  it("knows the script of every virama of Unicode 16.0", () => {
    const unknown = UNICODE_16_VIRAMAS.filter(
      (cp) => viramaScript(String.fromCodePoint(cp)) === undefined
    );
    expect(unknown.map((cp) => cp.toString(16))).toEqual([]);
  });

  it("names the script a virama belongs to", () => {
    expect(viramaScript("\u094D")).toBe("Devanagari");
    expect(viramaScript("\u0DCA")).toBe("Sinhala");
    expect(viramaScript("\u0D4D")).toBe("Malayalam");
    expect(viramaScript("a")).toBeUndefined();
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
    // A ZWJ ending a word after a virama asks for the half form or, in
    // Malayalam, the chillu — visible with nothing after it.
    ["ZWJ after a virama at the end (a chillu)", "അവന്\u200D", 4],
    ["ZWJ after a virama before punctuation", "അവന്\u200D.md", 4],
    ["ZWNJ after a virama on a letter with a nukta", "क\u093C्\u200Cष", 3],
    // Ninth review of #1242: a ZWJ ending a word after a virama is visible
    // only where the Unicode core spec (ch. 12) gives it a form to draw — a
    // Devanagari independent half form (§12.1, Figure 12-6, Table 12-4; RA
    // as eyelash, rule R5a), the legacy Bengali khanda ta (§12.2), a legacy
    // Malayalam chillu (§12.9, Table 12-40) — and only on letters that have
    // one.
    ["ZWJ after a Devanagari virama at the end (an independent half form)", "ग्\u200D", 2],
    ["ZWJ after a Devanagari RA at the end (eyelash RA)", "र्\u200D", 2],
    ["ZWJ after a Devanagari letter with a nukta at the end", "ज\u093C्\u200D", 3],
    ["ZWJ after a Bengali ta at the end (legacy khanda ta)", "হঠাত্\u200D", 5],
    // A ZWJ BEFORE a virama, where the spec gives it a form: the Bengali
    // ya-phalaa after ra (§12.2 "Interaction of Repha and Ya-phalaa"), also
    // after the Assamese ra; a cluster-initial RA that keeps its full form in
    // Devanagari (§12.1), Telugu (§12.7 "Reph") and Kannada (§12.8); Oriya
    // final half forms (§12.1, Figure 12-7); Malayalam traditional ligatures
    // (§12.9 "Requesting Traditional Ligatures").
    ["ZWJ between a Bengali ra and a virama (ya-phalaa)", "র\u200D্যাব", 1],
    ["ZWJ between an Assamese ra and a virama (ya-phalaa)", "ৰ\u200D্য", 1],
    ["ZWJ between a Devanagari RA and a virama", "र\u200D्य", 1],
    ["ZWJ between a Telugu ra and a virama", "ర\u200D్మ", 1],
    ["ZWJ between a Kannada ra and a virama", "ರ\u200D್ಕ", 1],
    ["ZWJ between an Oriya consonant and a virama (final half form)", "କ\u200D୍ତ", 1],
    ["ZWJ between a Malayalam consonant and a virama (traditional ligature)", "ക\u200D്ര", 1],
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
    // Eighth review of #1242: a ZWNJ after a virama was accepted whatever
    // came next, so `जगत्‌.md` and `जगत्.md` were two names that look the
    // same. A ZWNJ keeps a virama from forming a conjunct with the letter
    // after it; with no letter of that script after it, there is nothing to
    // keep apart.
    ["ZWNJ after a virama at the end", "जगत्\u200C"],
    ["ZWNJ after a virama before punctuation", "जगत्\u200C.md"],
    ["ZWNJ after a virama before a letter of another script", "क्\u200Cb"],
    ["ZWJ after a virama before a letter of another script", "क्\u200Db"],
    // …and the virama has to sit on a letter of its own script.
    ["ZWNJ after a virama on a Latin letter", "a्\u200Cb"],
    ["ZWJ after a virama on a Latin letter", "a्\u200D"],
    ["ZWNJ after a Sinhala virama on a Devanagari letter", "क\u0DCA\u200Cष"],
    ["ZWNJ after a virama with no letter before it", "\u094D\u200Cष"],
    // Ninth review of #1242 (the reviewer's probe names): a ZWJ ending a word
    // after a virama was accepted in every virama script, but a script with
    // no half form or chillu draws nothing for it — `தமிழ்‍.md` read exactly
    // like `தமிழ்.md`. With no letter after it, the joiner is accepted only
    // where the spec gives it a form; elsewhere a letter of the same script
    // has to follow it, as for a ZWNJ.
    ["ZWJ after a Tamil pulli at the end", "தமிழ்\u200D"],
    ["ZWJ after a Tamil pulli before punctuation", "தமிழ்\u200D.md"],
    ["ZWJ after a Thai phinthu at the end", "ก\u0E3A\u200D"],
    ["ZWJ after a Myanmar asat at the end", "ကျွန်\u200D"],
    ["ZWJ after a Telugu virama at the end", "జగత్\u200D"],
    // Gujarati has half forms inside a conjunct, but the spec documents no
    // independent one, so a word-final joiner is not taken on trust there.
    ["ZWJ after a Gujarati virama at the end", "જગત્\u200D"],
    // A Devanagari consonant without a half form falls back to the visible
    // virama (§12.1) — exactly what it shows without the joiner.
    ["ZWJ after a Devanagari TTA at the end (no half form)", "ट्\u200D"],
    ["ZWJ after a Devanagari DA at the end (no half form)", "द्\u200D"],
    ["ZWJ after a Devanagari RRA at the end (already eyelash, rule R5)", "ऱ्\u200D"],
    ["ZWJ after a Bengali ka at the end (not khanda ta)", "ক্\u200D"],
    ["ZWJ after a Malayalam ka at the end (no chillu)", "ക്\u200D"],
    // Before a virama: after a letter other than ra the Bengali ya-phalaa is
    // the default, and "a ZWJ is not necessary" (§12.2); the virama has to be
    // of the letter's script, and a letter of that script has to follow it.
    ["ZWJ between a Bengali ka and a virama", "ক\u200D্য"],
    ["ZWJ between a Tamil letter and a pulli", "க\u200D்ம"],
    ["ZWJ between a Bengali ra and a virama at the end", "র\u200D্"],
    ["ZWJ between a Bengali ra and a virama before a Latin letter", "র\u200D্a"],
    ["ZWJ between a Devanagari RA and a Bengali virama", "र\u200D্য"],
    ["ZWJ between a Latin letter and a virama", "a\u200D्य"],
    ["ZWNJ between a Bengali ra and a virama", "র\u200C্য"],
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
