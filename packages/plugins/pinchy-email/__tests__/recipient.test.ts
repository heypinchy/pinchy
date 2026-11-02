// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseSingleRecipient, splitMailbox } from "../recipient";

/**
 * `email_send` / `email_draft` take ONE recipient. The mail libraries behind
 * them (nodemailer for SMTP, a raw `To:` header for Gmail) parse a string as an
 * address LIST, so `"a@x.at, b@evil.com"` quietly delivers to both. The
 * confirmation card cannot make that obvious if the model can spell it — so the
 * tool refuses it and says why.
 */
describe("parseSingleRecipient", () => {
  it.each([
    ["ada@example.com", "ada@example.com"],
    ["  ada@example.com  ", "ada@example.com"],
    ["o'brien@example.com", "o'brien@example.com"],
    ["ada+tag@sub.example.co.uk", "ada+tag@sub.example.co.uk"],
    ["Ada Lovelace <ada@example.com>", "Ada Lovelace <ada@example.com>"],
    ["<ada@example.com>", "ada@example.com"],
    ["münchen@bücher.de", "münchen@bücher.de"],
  ])("accepts %j", (input, expected) => {
    expect(parseSingleRecipient(input)).toEqual({ ok: true, address: expected });
  });

  it.each([
    ["a comma-separated list", "chef@firma.at, angreifer@evil.com"],
    ["a list hidden behind padding", `chef@firma.at${" ".repeat(300)}, angreifer@evil.com`],
    ["a semicolon list", "a@x.at;b@evil.com"],
    ["a space-separated list", "a@x.at b@evil.com"],
    ["a quoted display name carrying a second address", '"a@x.at, b@evil.com" <c@x.at>'],
    ["a display name that looks like another address", "boss@firma.at <attacker@evil.com>"],
    ["a group", "friends: a@x.at, b@y.at;"],
    ["a line break", "a@x.at\nBcc: b@evil.com"],
    ["a control character", "a@x.at\u0000"],
    ["a bidi override", "a@x.at\u202Eb@evil.com"],
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["no @", "ada.example.com"],
    ["nothing after the @", "ada@"],
    ["two @", "a@b@evil.com"],
    ["a comment", "a@x.at (b@evil.com)"],
    // NFKC folds these into the ASCII characters they imitate (review of #1242).
    ["a fullwidth @ in the display name", "boss\uFF20firma.at <attacker@evil.com>"],
    ["a small-form @ in the display name", "boss\uFE6Bfirma.at <attacker@evil.com>"],
    ["a fullwidth @ in the local part", "chef\uFF20firma.at@evil.com"],
    ["a fullwidth comma between two addresses", "a\uFF20x.at\uFF0Cb@evil.com"],
    [
      "fullwidth angle brackets in the display name",
      "Boss \uFF1Cboss@firma.at\uFF1E <attacker@evil.com>",
    ],
  ])("rejects %s", (_label, input) => {
    const result = parseSingleRecipient(input);
    expect(result.ok).toBe(false);
  });

  it("rejects an array, a number and undefined, with a message that names the fix", () => {
    for (const bad of [["a@x.at", "b@evil.com"], 42, undefined, null]) {
      const result = parseSingleRecipient(bad);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/exactly one/i);
    }
  });

  it("still accepts a name and address whose letters NFKC leaves alone", () => {
    expect(parseSingleRecipient("Jos\u00E9 M\u00FCller <jose@b\u00FCcher.de>")).toEqual({
      ok: true,
      address: "Jos\u00E9 M\u00FCller <jose@b\u00FCcher.de>",
    });
  });

  // Second review of #1242: a familiar name padded with characters that render
  // blank (braille U+2800, Hangul fillers) pushed the real address out of view.
  it.each([
    ["braille pattern blanks", `Raimund Korber${"\u2800".repeat(190)} <attacker@evil.com>`],
    ["a hangul filler", "Raimund\u3164Korber <attacker@evil.com>"],
    ["a hangul choseong filler", "Raimund\u115FKorber <attacker@evil.com>"],
    ["a hangul jungseong filler", "Raimund\u1160Korber <attacker@evil.com>"],
    ["a halfwidth hangul filler", "Raimund\uFFA0Korber <attacker@evil.com>"],
    // Corrected expectation (ninth review of #1242): a single no-break or
    // ideographic space is part of real names — Japanese writes 山田\u3000太郎 —
    // and the card prints it as ⟨U+3000⟩, as it does in a path. A run of them
    // is still blank space that pushes the address out of view, so these rows
    // now test runs.
    ["a run of no-break spaces", "Raimund\u00A0\u00A0Korber <attacker@evil.com>"],
    ["a run of ideographic spaces", "Raimund\u3000\u3000Korber <attacker@evil.com>"],
    ["a space next to an ideographic space", "Raimund \u3000Korber <attacker@evil.com>"],
    // Corrected expectation (third review of #1242): this row used a zero-width
    // JOINER, which display names now accept — it sits inside ordinary emoji,
    // takes no space, and the card shows it as it is. The zero-width SPACE
    // (U+200B) stays refused, so the row keeps testing a zero-width refusal.
    ["a zero-width space", "Raimund\u200BKorber <attacker@evil.com>"],
    ["a paragraph separator", "Raimund\u2029Korber <attacker@evil.com>"],
    ["a lone surrogate", "Raimund\uD83DKorber <attacker@evil.com>"],
  ])("rejects a display name with %s, and says why", (_label, input) => {
    const result = parseSingleRecipient(input);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/invisible|blank/i);
  });

  // Ninth review of #1242: `"山田\u3000太郎" <yamada@example.jp>` was refused, although
  // a path may carry the same space. One space separator takes visible width,
  // and the card prints it as ⟨U+XXXX⟩, so the name reads unambiguously.
  it.each([
    [
      "an ideographic space",
      '"山田\u3000太郎" <yamada@example.jp>',
      "山田\u3000太郎 <yamada@example.jp>",
    ],
    [
      "a no-break space",
      "Raimund\u00A0Korber <rk@example.com>",
      "Raimund\u00A0Korber <rk@example.com>",
    ],
    [
      "a narrow no-break space",
      "Raimund\u202FKorber <rk@example.com>",
      "Raimund\u202FKorber <rk@example.com>",
    ],
  ])("accepts a display name with %s", (_label, input, address) => {
    expect(parseSingleRecipient(input)).toEqual({ ok: true, address });
  });

  it("still keeps a space separator out of the address", () => {
    expect(parseSingleRecipient("yamada\u3000@example.jp").ok).toBe(false);
    expect(parseSingleRecipient("山田 <yamada\u00A0@example.jp>").ok).toBe(false);
  });

  it("rejects a run of spaces, and says why", () => {
    for (const input of ["Raimund   Korber <a@x.at>", "Raimund Korber      <a@x.at>"]) {
      const result = parseSingleRecipient(input);
      expect(result.ok, input).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/run of spaces/i);
    }
  });

  it("caps the display name at 64 characters, and says so", () => {
    expect(parseSingleRecipient(`${"a".repeat(64)} <a@x.at>`).ok).toBe(true);
    const result = parseSingleRecipient(`${"a".repeat(65)} <a@x.at>`);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/64 characters/);
  });

  it("tells the model to call once per recipient when it sent a list", () => {
    const result = parseSingleRecipient("a@x.at, b@y.at");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/one recipient per call/i);
  });
});

// Third review of #1242: real names were refused. RFC 5322 lets a display
// name carry a comma or parentheses inside double quotes, and that is how a
// mail program writes "Müller, Hans". Unquoted, the same characters are a list
// separator and a comment — refused, with a message that names the fix.
describe("parseSingleRecipient: names with commas, parentheses and emoji", () => {
  it.each([
    ['"M\u00FCller, Hans" <hans@x.de>', '"M\u00FCller, Hans" <hans@x.de>'],
    ['"Raimund Korber (Noack)" <r@noack.at>', '"Raimund Korber (Noack)" <r@noack.at>'],
    [' "Meier; Partner" <m@x.at> ', '"Meier; Partner" <m@x.at>'],
    ['"Ada Lovelace" <ada@example.com>', "Ada Lovelace <ada@example.com>"],
    ["\u2764\uFE0F Team <t@x.at>", "\u2764\uFE0F Team <t@x.at>"],
    [
      "Familie \u{1F468}\u200D\u{1F469}\u200D\u{1F467} <f@x.at>",
      "Familie \u{1F468}\u200D\u{1F469}\u200D\u{1F467} <f@x.at>",
    ],
  ])("accepts %j", (input, expected) => {
    expect(parseSingleRecipient(input)).toEqual({ ok: true, address: expected });
  });

  it("tells the model to quote an unquoted name with a comma, not to send one call per recipient", () => {
    const result = parseSingleRecipient("M\u00FCller, Hans <hans@x.de>");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/double quotes/i);
    expect(result.error).toContain('"M\u00FCller, Hans" <hans@x.de>');
    expect(result.error).not.toMatch(/one recipient per call/i);
  });

  it("tells the model to quote an unquoted name with parentheses", () => {
    const result = parseSingleRecipient("Raimund Korber (Noack) <r@noack.at>");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/parenthes/i);
    expect(result.error).toContain('"Raimund Korber (Noack)" <r@noack.at>');
  });

  it.each([
    ["an @ inside the quotes", '"boss@firma.at" <attacker@evil.com>'],
    ["a quote inside the quotes", '"a\\"b" <a@x.at>'],
    ["angle brackets inside the quotes", '"<boss@firma.at>" <attacker@evil.com>'],
    ["an unterminated quote", '"Ada <ada@example.com>'],
    ["an emoji joiner in the address", "a\u200Db@x.at"],
    ["a variation selector in the address", "Ada <a\uFE0Fb@x.at>"],
    ["a quoted name over 64 characters", `"${"a".repeat(65)}" <a@x.at>`],
  ])("still rejects %s", (_label, input) => {
    expect(parseSingleRecipient(input).ok).toBe(false);
  });
});

// Seventh review of #1242: a ZWNJ was refused in every display name, but in
// Persian it is part of how a name is written — it keeps two letters that
// would join apart. It is accepted where it does that (IDNA's CONTEXTJ rule,
// RFC 5892 A.1, shared with the card through `emoji-sequence.ts`), and
// refused where it renders as nothing, as before.
describe("parseSingleRecipient: joiners that shape Arabic-script and Indic names", () => {
  it.each([
    ["a Persian name with a ZWNJ", "علی\u200Cرضا <a@x.ir>"],
    ["a Sinhala name with a ZWJ after al-lakuna", "ශ්\u200Dරී <s@x.lk>"],
  ])("accepts %s", (_label, input) => {
    expect(parseSingleRecipient(input)).toEqual({ ok: true, address: input });
  });

  it.each([
    ["a ZWNJ between Latin letters", "Ad\u200Ca <a@x.at>"],
    // د joins only to the right, so the ZWNJ after it changes nothing on
    // screen: this reads exactly like محمدرضا (the reviewer's probe name).
    ["a ZWNJ after a right-joining letter", "محمد\u200Cرضا <m@x.ir>"],
    ["a ZWNJ after a virama with no letter after it", "जगत्\u200C <j@x.in>"],
    ["a ZWNJ in the address itself", "علی\u200Cرضا@x.ir"],
    ["a ZWNJ in the address of a named recipient", "Ali <علی\u200Cرضا@x.ir>"],
  ])("refuses %s", (_label, input) => {
    expect(parseSingleRecipient(input).ok).toBe(false);
  });
});

describe("splitMailbox", () => {
  it("unquotes a quoted display name", () => {
    expect(splitMailbox('"M\u00FCller, Hans" <hans@x.de>')).toEqual({
      name: "M\u00FCller, Hans",
      address: "hans@x.de",
    });
  });

  it("splits a named address into its name and address", () => {
    expect(splitMailbox("Ada Lovelace <ada@example.com>")).toEqual({
      name: "Ada Lovelace",
      address: "ada@example.com",
    });
  });

  it("returns a bare address without a name", () => {
    expect(splitMailbox("ada@example.com")).toEqual({ address: "ada@example.com" });
    expect(splitMailbox("<ada@example.com>")).toEqual({ address: "ada@example.com" });
  });
});
