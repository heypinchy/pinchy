// @vitest-environment node
import { describe, it, expect } from "vitest";
import { markedFormatOffsets } from "./emoji-sequence";

/** The offsets `markedFormatOffsets` reports, as the code points found there. */
const marked = (text: string) =>
  [...markedFormatOffsets(text)].map((offset) => text.codePointAt(offset)!.toString(16));

/** Every U+200C / U+200D / U+FE0E / U+FE0F in `text`, as code points. */
const formatChars = (text: string) =>
  [...text.matchAll(/[\u200C\u200D\uFE0E\uFE0F]/g)].map((m) => m[0].codePointAt(0)!.toString(16));

/**
 * Canonical_Combining_Class = 9 (Virama) in Unicode 16.0, as Python's
 * `unicodedata.combining()` lists it. Ten reviews of #1242 asked, script by
 * script, where a joiner next to one of these draws something — and kept
 * finding scripts and fonts where it draws nothing (tenth review: Tamil
 * க்‌ம, Thai กฺ‍ม, Myanmar က်‍မ, Sinhala ක්‍ම, Gurmukhi ਕ੍‍ਮ, Malayalam
 * ക്‌മ, even Devanagari क्‍म in Devanagari MT, each pixel-identical to the
 * same name without it). The card no longer asks: next to every one of them
 * the joiner is marked.
 */
const UNICODE_16_VIRAMAS = [
  0x94d, 0x9cd, 0xa4d, 0xacd, 0xb4d, 0xbcd, 0xc4d, 0xccd, 0xd3b, 0xd3c, 0xd4d, 0xdca, 0xe3a, 0xeba,
  0xf84, 0x1039, 0x103a, 0x1714, 0x1715, 0x1734, 0x17d2, 0x1a60, 0x1b44, 0x1baa, 0x1bab, 0x1bf2,
  0x1bf3, 0x2d7f, 0xa806, 0xa82c, 0xa8c4, 0xa953, 0xa9c0, 0xaaf6, 0xabed, 0x10a3f, 0x11046, 0x11070,
  0x1107f, 0x110b9, 0x11133, 0x11134, 0x111c0, 0x11235, 0x112ea, 0x1134d, 0x113ce, 0x113cf, 0x113d0,
  0x11442, 0x114c2, 0x115bf, 0x1163f, 0x116b6, 0x1172b, 0x11839, 0x1193d, 0x1193e, 0x119e0, 0x11a34,
  0x11a47, 0x11a99, 0x11c3f, 0x11d44, 0x11d45, 0x11d97, 0x11f41, 0x11f42, 0x1612f,
];

describe("markedFormatOffsets: a joiner next to a virama", () => {
  it("marks a ZWNJ or ZWJ after every virama of Unicode 16.0", () => {
    const shownRaw = UNICODE_16_VIRAMAS.flatMap((cp) =>
      ["\u200C", "\u200D"].map((joiner) => `${String.fromCodePoint(cp)}${joiner}`)
    ).filter((text) => marked(text).length !== 1);
    expect(shownRaw).toEqual([]);
  });

  it("marks a ZWJ before every virama of Unicode 16.0", () => {
    const shownRaw = UNICODE_16_VIRAMAS.map((cp) => `a\u200D${String.fromCodePoint(cp)}`).filter(
      (text) => marked(text).length !== 1
    );
    expect(shownRaw).toEqual([]);
  });
});

describe("markedFormatOffsets: the tenth review's mid-word probes", () => {
  // Each pixel-identical to the same name without the joiner in at least one
  // shipping font, which is what made `pinchy_delete path:"/data/out/க்‌ம.md"`
  // read on the card as `/data/out/க்ம.md`.
  it.each([
    ["a ZWNJ between a Tamil pulli and a letter", "க்\u200Cம"],
    ["a ZWJ between a Tamil pulli and a letter", "க்\u200Dம"],
    ["a ZWJ between a Thai phinthu and a letter", "ก\u0E3A\u200Dม"],
    ["a ZWJ between a Myanmar asat and a letter", "က်\u200Dမ"],
    ["a ZWJ between a Sinhala al-lakuna and ma", "ක\u0DCA\u200Dම"],
    ["a ZWJ between a Gurmukhi virama and a letter", "ਕ੍\u200Dਮ"],
    ["a ZWNJ between a Malayalam virama and a letter", "ക്\u200Cമ"],
    ["a ZWJ between a Gujarati virama and a letter", "ક્\u200Dમ"],
    ["a ZWJ between a Devanagari virama and a letter", "क्\u200Dम"],
  ])("marks %s", (_label, text) => {
    expect(marked(text)).toEqual(formatChars(text));
  });

  // The ones the Unicode core spec (ch. 12) does give a form are marked too:
  // a marker on an approval card costs a glance, and deciding per script and
  // per font where the form is drawn is what failed ten times.
  it("marks a joiner the core spec gives a form as well", () => {
    for (const text of [
      "ශ\u0DCA\u200Dරී",
      "അവന്\u200D",
      "क्\u200Cष",
      "র\u200D্যাংকিং",
      "ग्\u200D",
    ]) {
      expect(marked(text), text).toEqual(formatChars(text));
    }
  });
});

// The seventh to ninth reviews' cases, which the old per-script rule showed
// raw. None of them is shown raw any more.
describe("markedFormatOffsets: joiners the old per-script rule showed raw", () => {
  it.each([
    ["ZWNJ after a virama", "क्\u200Cष"],
    ["ZWJ after a virama", "ශ\u0DCA\u200Dරී"],
    ["ZWNJ between two dual-joining letters", "گزارش\u200Cها"],
    ["ZWNJ between a dual- and a right-joining letter", "علی\u200Cرضا"],
    ["ZWNJ with vowel marks on either side", "مِ\u200Cِه"],
    ["ZWJ after a virama at the end (a chillu)", "അവന്\u200D"],
    ["ZWJ after a virama before punctuation", "അവന്\u200D.md"],
    ["ZWNJ after a virama on a letter with a nukta", "क\u093C्\u200Cष"],
    ["ZWJ after a Devanagari virama at the end (an independent half form)", "ग्\u200D"],
    ["ZWJ after a Devanagari RA at the end (eyelash RA)", "र्\u200D"],
    ["ZWJ after a Devanagari letter with a nukta at the end", "ज\u093C्\u200D"],
    ["ZWJ after a Bengali ta at the end (legacy khanda ta)", "হঠাত্\u200D"],
    ["ZWJ between a Bengali ra and a virama (ya-phalaa)", "র\u200D্যাব"],
    ["ZWJ between an Assamese ra and a virama (ya-phalaa)", "ৰ\u200D্য"],
    ["ZWJ between a Devanagari RA and a virama", "र\u200D्य"],
    ["ZWJ between a Telugu ra and a virama", "ర\u200D్మ"],
    ["ZWJ between a Kannada ra and a virama", "ರ\u200D್ಕ"],
    ["ZWJ between an Oriya consonant and a virama (final half form)", "କ\u200D୍ତ"],
    ["ZWJ between a Malayalam consonant and a virama (traditional ligature)", "ക\u200D്ര"],
  ])("marks %s", (_label, text) => {
    expect(marked(text)).toEqual(formatChars(text));
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
    ["ZWNJ after a virama at the end", "जगत्\u200C"],
    ["ZWNJ after a virama before punctuation", "जगत्\u200C.md"],
    ["ZWNJ after a virama before a letter of another script", "क्\u200Cb"],
    ["ZWJ after a virama before a letter of another script", "क्\u200Db"],
    ["ZWNJ after a virama on a Latin letter", "a्\u200Cb"],
    ["ZWJ after a virama on a Latin letter", "a्\u200D"],
    ["ZWNJ after a Sinhala virama on a Devanagari letter", "क\u0DCA\u200Cष"],
    ["ZWNJ after a virama with no letter before it", "\u094D\u200Cष"],
    ["ZWJ after a Tamil pulli at the end", "தமிழ்\u200D"],
    ["ZWJ after a Tamil pulli before punctuation", "தமிழ்\u200D.md"],
    ["ZWJ after a Thai phinthu at the end", "ก\u0E3A\u200D"],
    ["ZWJ after a Myanmar asat at the end", "ကျွန်\u200D"],
    ["ZWJ after a Telugu virama at the end", "జగత్\u200D"],
    ["ZWJ after a Gujarati virama at the end", "જગત્\u200D"],
    ["ZWJ after a Devanagari TTA at the end (no half form)", "ट्\u200D"],
    ["ZWJ after a Devanagari DA at the end (no half form)", "द्\u200D"],
    ["ZWJ after a Devanagari RRA at the end (already eyelash, rule R5)", "ऱ्\u200D"],
    ["ZWJ after a Bengali ka at the end (not khanda ta)", "ক্\u200D"],
    ["ZWJ after a Malayalam ka at the end (no chillu)", "ക്\u200D"],
    ["ZWJ between a Bengali ka and a virama", "ক\u200D্য"],
    ["ZWJ between a Tamil letter and a pulli", "க\u200D்ம"],
    ["ZWJ between a Bengali ra and a virama at the end", "র\u200D্"],
    ["ZWJ between a Bengali ra and a virama before a Latin letter", "র\u200D্a"],
    ["ZWJ between a Devanagari RA and a Bengali virama", "र\u200D্য"],
    ["ZWJ between a Latin letter and a virama", "a\u200D्य"],
    ["ZWNJ between a Bengali ra and a virama", "র\u200C্য"],
  ])("still marks %s", (_label, text) => {
    expect(marked(text)).toEqual(formatChars(text));
  });
});

describe("markedFormatOffsets: emoji", () => {
  // Inside a full RGI emoji (`\p{RGI_Emoji}`, Unicode's list of the emoji
  // every vendor draws) the joiner and the selectors are part of one glyph.
  it.each([
    ["a family", "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}"],
    ["a rainbow flag", "\u{1F3F3}\uFE0F\u200D\u{1F308}"],
    ["a skin-toned technologist", "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}"],
    ["a heart on fire", "❤\uFE0F\u200D\u{1F525}"],
    ["a keycap", "1\uFE0F\u20E3"],
    ["a warning sign shown as emoji", "⚠\uFE0F"],
    ["an eye in a speech bubble", "\u{1F441}\uFE0F\u200D\u{1F5E8}\uFE0F"],
  ])("shows the format characters of %s as they are", (_label, text) => {
    expect(marked(`x ${text} y`)).toEqual([]);
  });

  // Tenth review of #1242: any two pictographs joined by a ZWJ were taken as
  // one emoji, but 📄‍📄 is drawn exactly like 📄📄.
  it.each([
    ["two pages joined", "\u{1F4C4}\u200D\u{1F4C4}", ["200d"]],
    ["a heart on fire without its selector", "❤\u200D\u{1F525}", ["200d"]],
    [
      "a family joined to a page",
      "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}\u200D\u{1F4C4}",
      ["200d"],
    ],
    ["a rainbow flag without its selector", "\u{1F3F3}\u200D\u{1F308}", ["200d"]],
    ["a selector after an emoji-by-default check mark", "✅\uFE0F", ["fe0f"]],
    ["a text selector after a warning sign", "⚠\uFE0E", ["fe0e"]],
    ["a text selector after a check mark", "✅\uFE0E", ["fe0e"]],
    ["a second selector", "⚠\uFE0F\uFE0F", ["fe0f"]],
    ["a joiner trailing an emoji", "\u{1F468}\u200D", ["200d"]],
    ["a joiner before an emoji", "a\u200D\u{1F468}", ["200d"]],
  ])("marks %s", (_label, text, expected) => {
    expect(marked(text)).toEqual(expected);
  });
});

describe("markedFormatOffsets", () => {
  it("marks a format character unless it is inside an RGI emoji", () => {
    const text =
      "a\u200Cb \u{1F468}\u200D\u{1F469}\u200D\u{1F467} ශ\u0DCA\u200Dරී x\u200Dy \u{1F4C4}\u200D\u{1F4C4}";
    const offsets = [...markedFormatOffsets(text)];
    expect(offsets.map((offset) => text.codePointAt(offset)!.toString(16))).toEqual([
      "200c",
      "200d",
      "200d",
      "200d",
    ]);
    // The family's two joiners are the ones left out.
    const family = text.indexOf("\u200D");
    expect(offsets).not.toContain(family);
    expect(offsets).not.toContain(text.indexOf("\u200D", family + 1));
  });
});
