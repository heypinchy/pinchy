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
    ["a braille blank", "⠀", /U\+2800/],
    ["a hangul filler", "ㅤ", /U\+3164/],
    ["a line separator", " ", /U\+2028/],
    ["a lone surrogate", "\uD83D", /U\+D83D/],
  ])("still refuses %s", (_label, char, why) => {
    refused(`/data/a${char}b.md`, why);
  });

  // Fifth review of #1242: U+FE0F and U+200D were refused outright, so
  // ordinary emoji file names could not be written or deleted although the
  // card shows them unchanged. Inside a full RGI emoji they are part of a
  // visible glyph.
  it.each([
    ["an emoji with a presentation selector", "/data/notes/⚠️ offen.md"],
    ["a heart with a presentation selector", "/data/notes/❤️ Team.md"],
    ["a joined family", "/data/notes/\u{1F468}‍\u{1F469}‍\u{1F467} Familie.md"],
    ["an emoji without format characters", "/data/notes/✅ done.md"],
    ["a skin-toned joined emoji", "/data/notes/\u{1F469}\u{1F3FD}‍\u{1F4BB} Dev.md"],
    ["a flag joined with a selector", "/data/notes/\u{1F3F3}️‍\u{1F308} Pride.md"],
    ["a keycap", "/data/notes/1️⃣ first.md"],
  ])("accepts %s", (_label, value) => {
    ok(value);
  });

  // A presentation selector outside a full RGI emoji draws nothing that a
  // file name needs — `⚠︎ text.md` is drawn exactly like `⚠ text.md` in
  // Helvetica (tenth review of #1242) — so it stays refused.
  it.each([
    ["a presentation selector after a letter", "/data/report️.md", /U\+FE0F/],
    ["a presentation selector after a digit", "/data/report1️.md", /U\+FE0F/],
    ["two selectors after an emoji", "/data/⚠️️.md", /U\+FE0F/],
    ["a text-presentation selector", "/data/notes/⚠︎ text.md", /U\+FE0E/],
  ])("still refuses %s, which renders as nothing", (_label, value, why) => {
    refused(value, why);
  });

  // Tenth review of #1242: a joiner is accepted anywhere, and the card marks
  // it as ⟨U+200C⟩ / ⟨U+200D⟩ everywhere outside a full RGI emoji — the way a
  // no-break space in a path is accepted and marked. Deciding per script
  // where it draws something failed for ten reviews; the marker keeps two
  // names that differ only by a joiner apart on the card.
  it.each([
    ["a zero-width joiner between letters", "/data/a‍b.md"],
    ["a zero-width non-joiner between letters", "/data/a‌b.md"],
    ["a joiner after an emoji, before a letter", "/data/\u{1F468}‍b.md"],
    ["a joiner trailing an emoji", "/data/\u{1F468}‍.md"],
    ["a joiner before an emoji", "/data/a‍\u{1F468}.md"],
    ["two pages joined, which no vendor draws as one", "/data/\u{1F4C4}‍\u{1F4C4}.md"],
    ["a family joined to a page", "/data/\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F4C4}.md"],
  ])("accepts %s; the card marks the joiner", (_label, value) => {
    ok(value);
  });

  // Seventh review of #1242: U+200C was refused everywhere and U+200D outside
  // an emoji, but Arabic-script and Indic names carry them — the Persian
  // plural گزارش‌ها, Sinhala ශ්‍රී, Malayalam അവന്‍. They are accepted, and
  // marked on the card like every joiner outside an emoji.
  it.each([
    ["a Persian plural with a ZWNJ", "/data/output/گزارش‌ها.md"],
    ["Sinhala Sri with a ZWJ after al-lakuna", "/data/output/ශ්‍රී ලංකා.md"],
    ["a Malayalam chillu with a ZWJ after the virama", "/data/output/അവന്‍.md"],
    ["a Devanagari half form with a ZWNJ after the virama", "/data/output/क्‌ष.md"],
    ["a ZWNJ after a dual-joining letter with a vowel mark", "/data/output/مِ‌ها.md"],
    ["a Bengali ra-yaphala with a ZWJ before the virama", "/data/out/র‍্যাংকিং.md"],
    ["a Devanagari half form at the end of a name", "/data/out/ग्‍.md"],
  ])("accepts %s; the card marks the joiner", (_label, value) => {
    ok(value);
  });

  // The seventh to tenth reviews' probe names: each draws nothing in at least
  // one font. They were refused while the rule tried to tell them apart from
  // the names above; now they are accepted and marked like those.
  it.each([
    ["a ZWNJ after a right-joining letter", "/data/محمد‌رضا.md"],
    ["a ZWNJ with no letter after it", "/data/گزارش‌.md"],
    ["a ZWNJ before a non-joining hamza", "/data/ش‌ء.md"],
    ["a ZWJ between Arabic letters", "/data/ش‍ه.md"],
    ["a ZWNJ between Latin letters next to Persian", "/data/گزارش a‌b.md"],
    ["a ZWNJ after a virama at the end of a name", "/data/out/जगत्‌.md"],
    ["a ZWNJ after a virama on a Latin letter", "/data/out/a्‌b.md"],
    ["a ZWJ after a Tamil pulli at the end of a name", "/data/out/தமிழ்‍.md"],
    ["a ZWJ after a Thai phinthu at the end of a name", "/data/out/กฺ‍.md"],
    ["a ZWJ after a Telugu virama at the end of a name", "/data/out/జగత్‍.md"],
    ["a ZWNJ inside a Tamil word", "/data/out/க்‌ம.md"],
    ["a ZWJ inside a Myanmar word", "/data/out/က်‍မ.md"],
  ])("accepts %s; the card marks the joiner", (_label, value) => {
    ok(value);
  });

  // Sixth review of #1242: ✅ is shown as an emoji by default, so a U+FE0F
  // after it changes nothing on screen — `Vertrag ✅️.pdf` read exactly like
  // `Vertrag ✅.pdf` and is a different file. None of these is a full RGI
  // emoji, so the selector is refused like any other invisible character.
  it.each([
    ["after an emoji-by-default check mark", "/data/out/Vertrag ✅️.pdf"],
    ["after an emoji-by-default page", "/data/out/\u{1F4C4}️.md"],
    ["after a skin tone", "/data/out/\u{1F44D}\u{1F3FD}️.md"],
  ])("refuses a presentation selector that changes nothing: %s", (_label, value) => {
    refused(value, /U\+FE0F/);
  });

  // `✅︎` is not an RGI emoji either: Helvetica draws it exactly like `✅`
  // (tenth review of #1242).
  it("accepts a selector only inside a full RGI emoji", () => {
    ok("/data/notes/⚠️ offen.md");
    refused("/data/out/Vertrag ✅︎.pdf", /U\+FE0E/);
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
