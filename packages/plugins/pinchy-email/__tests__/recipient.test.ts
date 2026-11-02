// @vitest-environment node
import { describe, it, expect } from "vitest";
import { parseSingleRecipient } from "../recipient";

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

  it("tells the model to call once per recipient when it sent a list", () => {
    const result = parseSingleRecipient("a@x.at, b@y.at");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/one recipient per call/i);
  });
});
