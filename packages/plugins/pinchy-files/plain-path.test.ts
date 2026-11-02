// @vitest-environment node
import { describe, it, expect } from "vitest";
import { assertPlainPath } from "./plain-path";

/**
 * Third review of #1242: `..` and blank characters were refused, but "./"
 * segments were not — 2,100 of them pushed `contracts/signed.pdf` past what the
 * card stored, while the write still landed there. A path is accepted only in
 * the form that names its target directly.
 */
describe("assertPlainPath", () => {
  const ok = (value: string) => expect(() => assertPlainPath(value, "path")).not.toThrow();
  const refused = (value: string, why: RegExp) =>
    expect(() => assertPlainPath(value, "path")).toThrow(why);

  it("accepts a path in its plain form", () => {
    ok("/data/output/contracts/signed.pdf");
    ok("reports/Q3 Bericht.md");
    ok("report.pdf");
    ok("/data/Screenshot 2026-11-02 at 10.00.00 AM.png");
  });

  it("refuses the review's probe", () => {
    refused(`/data/output/${"./".repeat(2100)}contracts/signed.pdf`, /path/);
  });

  it.each([
    ["a '.' segment", "/data/output/./contracts/signed.pdf"],
    ["a leading '.' segment", "./contracts/signed.pdf"],
    ["an empty segment", "/data/output//contracts/signed.pdf"],
    ["a trailing slash", "/data/output/contracts/"],
    ["a lone dot", "."],
    ["an empty path", ""],
  ])("refuses %s, and says to send the plain form", (_label, value) => {
    refused(value, /plain form/);
  });

  it("caps the length at 1,024 characters", () => {
    ok(`/data/${"a".repeat(1018)}`);
    refused(`/data/${"a".repeat(1019)}`, /longer than 1024/);
  });

  it.each([
    ["a no-break space", " "],
    ["a narrow no-break space", " "],
    ["an ideographic space", "　"],
  ])("accepts %s, which the card prints as a marker", (_label, char) => {
    ok(`/data/a${char}b.md`);
  });

  it.each([
    ["a zero-width space", "​", /U\+200B/],
    ["a zero-width joiner", "‍", /U\+200D/],
    ["a braille blank", "⠀", /U\+2800/],
    ["a hangul filler", "ㅤ", /U\+3164/],
    ["a line separator", " ", /U\+2028/],
    ["a lone surrogate", "\uD83D", /U\+D83D/],
  ])("still refuses %s", (_label, char, why) => {
    refused(`/data/a${char}b.md`, why);
  });

  // Fifth review of #1242: U+FE0F and U+200D were refused outright, so
  // ordinary emoji file names could not be written or deleted although the
  // card shows them unchanged. Inside an emoji they are part of a visible
  // glyph; anywhere else they render as nothing and stay refused.
  it.each([
    ["an emoji with a presentation selector", "/data/notes/⚠️ offen.md"],
    ["a heart with a presentation selector", "/data/notes/❤️ Team.md"],
    ["a joined family", "/data/notes/👨‍👩‍👧 Familie.md"],
    ["an emoji without format characters", "/data/notes/✅ done.md"],
    ["a skin-toned joined emoji", "/data/notes/👩🏽‍💻 Dev.md"],
    ["a flag joined with a selector", "/data/notes/🏳️‍🌈 Pride.md"],
    ["a text-presentation selector", "/data/notes/⚠︎ text.md"],
    ["a keycap", "/data/notes/1️⃣ first.md"],
  ])("accepts %s", (_label, value) => {
    ok(value);
  });

  it.each([
    ["a joiner between letters", "/data/a\u200Db.md", /U\+200D/],
    ["a presentation selector after a letter", "/data/report\uFE0F.md", /U\+FE0F/],
    ["a presentation selector after a digit", "/data/report1\uFE0F.md", /U\+FE0F/],
    ["a joiner after an emoji, before a letter", "/data/👨\u200Db.md", /U\+200D/],
    ["a joiner trailing an emoji", "/data/👨\u200D.md", /U\+200D/],
    ["a joiner before an emoji", "/data/a\u200D👨.md", /U\+200D/],
    ["two selectors after an emoji", "/data/⚠\uFE0F\uFE0F.md", /U\+FE0F/],
  ])("still refuses %s, which renders as nothing", (_label, value, why) => {
    refused(value, why);
  });

  // Seventh review of #1242: U+200C was refused everywhere and U+200D outside
  // an emoji, but in Arabic-script and Indic text they shape what you see —
  // the Persian plural گزارش‌ها keeps its ش unjoined, Sinhala ශ්‍රී is drawn
  // with a rakaaraansaya, Malayalam അവന്‍ ends in a chillu. They are accepted
  // where IDNA's CONTEXTJ rule (RFC 5892 A.1/A.2) says they do something:
  // after a virama, and a ZWNJ between two letters that would otherwise join.
  it.each([
    ["a Persian plural with a ZWNJ", "/data/output/گزارش\u200Cها.md"],
    ["Sinhala Sri with a ZWJ after al-lakuna", "/data/output/ශ්\u200Dරී ලංකා.md"],
    ["a Malayalam chillu with a ZWJ after the virama", "/data/output/അവന്\u200D.md"],
    ["a Devanagari half form with a ZWNJ after the virama", "/data/output/क्\u200Cष.md"],
    ["a ZWNJ after a dual-joining letter with a vowel mark", "/data/output/مِ\u200Cها.md"],
    // Ninth review of #1242 (the reviewer's probe names): the Bengali ya-phalaa
    // after ra is written with a ZWJ before the virama (Unicode core spec
    // §12.2) — without it the ra turns into a repha.
    ["a Bengali ra-yaphala with a ZWJ before the virama", "/data/out/র\u200D্যাংকিং.md"],
    ["a Devanagari half form at the end of a name", "/data/out/ग्\u200D.md"],
  ])("accepts %s, which shapes the text", (_label, value) => {
    ok(value);
  });

  it.each([
    ["a ZWNJ between Latin letters", "/data/a\u200Cb.md", /U\+200C/],
    // د only joins to the right, so a ZWNJ after it changes nothing on screen:
    // محمد‌رضا reads exactly like محمدرضا (the reviewer's probe name).
    ["a ZWNJ after a right-joining letter", "/data/محمد\u200Cرضا.md", /U\+200C/],
    ["a ZWNJ with no letter after it", "/data/گزارش\u200C.md", /U\+200C/],
    ["a ZWNJ before a non-joining hamza", "/data/ش\u200Cء.md", /U\+200C/],
    ["a ZWJ between Arabic letters", "/data/ش\u200Dه.md", /U\+200D/],
    ["a ZWNJ between Latin letters next to Persian", "/data/گزارش a\u200Cb.md", /U\+200C/],
    // Eighth review of #1242 (the reviewer's probe names): a ZWNJ after a
    // virama with no letter after it changes nothing, so this read exactly
    // like /data/out/जगत्.md; and a virama on a Latin letter shapes nothing.
    ["a ZWNJ after a virama at the end of a name", "/data/out/जगत्\u200C.md", /U\+200C/],
    ["a ZWNJ after a virama on a Latin letter", "/data/out/a्\u200Cb.md", /U\+200C/],
    // Ninth review of #1242 (the reviewer's probe names): a ZWJ ending a word
    // after a virama draws nothing in a script without half forms or chillus,
    // so each of these reads exactly like the same path without it.
    ["a ZWJ after a Tamil pulli at the end of a name", "/data/out/தமிழ்\u200D.md", /U\+200D/],
    ["a ZWJ after a Thai phinthu at the end of a name", "/data/out/ก\u0E3A\u200D.md", /U\+200D/],
    ["a ZWJ after a Telugu virama at the end of a name", "/data/out/జగత్\u200D.md", /U\+200D/],
  ])("still refuses %s, which renders as nothing", (_label, value, why) => {
    refused(value, why);
  });

  // Sixth review of #1242: ✅ is shown as an emoji by default, so a U+FE0F
  // after it changes nothing on screen — `Vertrag ✅️.pdf` read exactly like
  // `Vertrag ✅.pdf` and is a different file. A selector that asks for the
  // presentation a character already has is refused like any other invisible
  // character; one that changes it (⚠️, ✅︎) is part of what you see.
  it.each([
    ["after an emoji-by-default check mark", "/data/out/Vertrag \u2705\uFE0F.pdf"],
    ["after an emoji-by-default page", "/data/out/\u{1F4C4}\uFE0F.md"],
    ["after a skin tone", "/data/out/\u{1F44D}\u{1F3FD}\uFE0F.md"],
  ])("refuses a presentation selector that changes nothing: %s", (_label, value) => {
    refused(value, /U\+FE0F/);
  });

  it("still accepts a selector that changes the presentation", () => {
    ok("/data/out/Vertrag \u2705\uFE0E.pdf");
    ok("/data/notes/\u26A0\uFE0F offen.md");
  });

  // Sixth review of #1242: `/data/out/report.md ` read on the card exactly
  // like `/data/out/report.md`, and is a different file.
  it.each([
    ["a trailing space", "/data/out/report.md "],
    ["a leading space", " /data/out/report.md"],
    ["a space before a slash", "/data/out /report.md"],
    ["a space after a slash", "/data/ out/report.md"],
    ["a trailing no-break space", "/data/out/report.md\u00A0"],
    ["a leading ideographic space", "/data/out/\u3000report.md"],
  ])("refuses a file or folder name with %s", (_label, value) => {
    refused(value, /space at the start or end/);
  });

  // pinchy_generate_file trims the name itself, so both spellings name the
  // one file it writes; everything else still applies.
  it("lets a tool that trims the name accept surrounding spaces, and nothing more", () => {
    const trimmed = (value: string) => () =>
      assertPlainPath(value, "filename", { trimmedByTool: true });
    expect(trimmed("  padded  ")).not.toThrow();
    expect(trimmed("padded\u2800")).toThrow(/U\+2800/);
    expect(trimmed("\u2705\uFE0F")).toThrow(/U\+FE0F/);
  });

  it("still refuses an NFD path and a '..' segment", () => {
    refused("/data/übersicht.md", /NFC/);
    refused("/data/reports/../contracts/x.pdf", /\.\./);
  });
});
