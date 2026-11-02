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

  it("still refuses an NFD path and a '..' segment", () => {
    refused("/data/übersicht.md", /NFC/);
    refused("/data/reports/../contracts/x.pdf", /\.\./);
  });
});
