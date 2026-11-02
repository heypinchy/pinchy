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

  it("still refuses an NFD path and a '..' segment", () => {
    refused("/data/übersicht.md", /NFC/);
    refused("/data/reports/../contracts/x.pdf", /\.\./);
  });
});
