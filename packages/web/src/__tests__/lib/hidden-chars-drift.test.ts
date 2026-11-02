/**
 * Drift guard for "which characters render as nothing or as blank space".
 *
 * Three places answer that question (second review of #1242): pinchy-email
 * refuses such characters in a recipient, pinchy-files refuses them in a path,
 * and the approval summary escapes them as `⟨U+XXXX⟩` so the card shows them.
 * Plugins cannot import each other or the web package, so the plugin rule is
 * duplicated (`hidden-chars.ts`, pinned byte-identical here), and the summary
 * keeps its own regex — pinned here to the plugin rule over every code point,
 * so a character one side treats as hidden cannot pass the other unseen.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isEscapedChar, summarizeCall } from "@/lib/approvals/summary";
import {
  hiddenCharIn,
  isEmojiFormatChar,
  isSpaceSeparator,
} from "../../../../plugins/pinchy-email/hidden-chars";
import { assertPlainPath } from "../../../../plugins/pinchy-files/plain-path";
import { parseSingleRecipient } from "../../../../plugins/pinchy-email/recipient";

const copiesOf = (file: string) =>
  ["pinchy-email", "pinchy-files"].map((plugin) =>
    resolve(import.meta.dirname, `../../../../plugins/${plugin}/${file}`)
  );
const COPIES = copiesOf("hidden-chars.ts");

/** Kept readable by the summary on purpose: layout (tab, line break), the
 * three emoji code points and the zero-width non-joiner, which cannot carry a
 * payload. The card marks those four wherever they render as nothing
 * (`emoji-sequence.ts`); the tools refuse them there. */
const SUMMARY_KEEPS = new Set([0x09, 0x0a, 0x200c, 0x200d, 0xfe0e, 0xfe0f]);

describe("hidden-chars drift guard", () => {
  it("is identical in every plugin that carries it", () => {
    const [first, ...rest] = COPIES.map((file) => readFileSync(file, "utf8"));
    expect(first).toContain("export function hiddenCharIn(");
    for (const copy of rest) expect(copy).toBe(first);
  });

  // Seventh review of #1242: the recipient check now reads joiners through the
  // same rule as the path check and the card, so pinchy-email carries a copy.
  it("the joiner and emoji rule is identical in every plugin that carries it", () => {
    const [first, ...rest] = copiesOf("emoji-sequence.ts").map((file) =>
      readFileSync(file, "utf8")
    );
    expect(first).toContain("export function invisibleFormatOffsets(");
    expect(rest).toHaveLength(1);
    for (const copy of rest) expect(copy).toBe(first);
  });

  // Lone surrogates included (third review of #1242): the summary escapes them
  // — Postgres refuses one inside jsonb — and the tools refuse them.
  it("the summary escapes exactly what the tools refuse, minus layout and emoji", () => {
    const mismatches: string[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      const char = String.fromCodePoint(cp);
      const refused = hiddenCharIn(char) !== null;
      const expected = refused && !SUMMARY_KEEPS.has(cp);
      if (isEscapedChar(char) !== expected) mismatches.push(cp.toString(16));
    }
    expect(mismatches).toEqual([]);
  });

  it("covers the blank-rendering characters of the review", () => {
    for (const char of ["⠀", "ㅤ", "ᅟ", "ᅠ", "ﾠ", " ", "　"]) {
      expect(hiddenCharIn(`a${char}b`)).toBe(
        `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`
      );
    }
    expect(hiddenCharIn("plain text with spaces")).toBeNull();
  });
  // Third review of #1242: each tool now allows one group the default refuses,
  // and each allowance is only safe because of what the card does with it.
  describe("the deliberate allowances", () => {
    const every = (pick: (char: string) => boolean) => {
      const found: number[] = [];
      for (let cp = 0; cp <= 0x10ffff; cp++) {
        if (pick(String.fromCodePoint(cp))) found.push(cp);
      }
      return found;
    };

    it("a display name may carry exactly the emoji characters the card shows as they are", () => {
      const allowed = every(isEmojiFormatChar);
      expect(allowed).toEqual(
        [...SUMMARY_KEEPS].filter((cp) => cp > 0x0a && cp !== 0x200c).sort((a, b) => a - b)
      );
      for (const cp of allowed) {
        const char = String.fromCodePoint(cp);
        expect(hiddenCharIn(char)).not.toBeNull();
        expect(hiddenCharIn(char, isEmojiFormatChar)).toBeNull();
        expect(isEscapedChar(char)).toBe(false);
      }
    });

    // Fifth review of #1242: ordinary emoji file names (⚠️, 👨‍👩‍👧) could not be
    // written. The card shows these characters as they are, so a path may
    // carry them only where they are part of a visible emoji — never on their
    // own, where `a⟨U+200D⟩b.md` would read as `ab.md`.
    it("a path may carry the emoji characters inside an emoji, and nowhere else", () => {
      for (const cp of every(isEmojiFormatChar)) {
        const char = String.fromCodePoint(cp);
        const inEmoji = char === "\u200D" ? `\u{1F468}${char}\u{1F469}` : `\u26A0${char}`;
        expect(() => assertPlainPath(`/data/${inEmoji} x.md`, "path")).not.toThrow();
        expect(() => assertPlainPath(`/data/a${char}b.md`, "path")).toThrow(/U\+/);
      }
    });

    // Sixth review of #1242: the card kept the joiner and the presentation
    // selectors raw everywhere, so a stray one read as nothing on the card
    // while the path rule refused it. Both now read emoji through one module
    // (pinchy-files `emoji-sequence.ts`); pinned here so they cannot drift:
    // the card marks one of these characters exactly where a path may not
    // carry it.
    it("the card marks a joiner or selector in a path exactly where the path rule refuses it", () => {
      const names = [
        "\u26A0\uFE0F offen",
        "\u26A0\uFE0E text",
        "\u2705 done",
        "\u2705\uFE0F done",
        "\u2705\uFE0E done",
        "\u{1F4C4}\uFE0F",
        "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
        "\u{1F469}\u{1F3FD}\u200D\u{1F4BB}",
        "\u{1F3F3}\uFE0F\u200D\u{1F308}",
        "1\uFE0F\u20E3 first",
        "a\u200Db",
        "report\uFE0F",
        "\u{1F468}\u200Db",
        "\u{1F468}\u200D",
        "a\u200D\u{1F468}",
        "\u26A0\uFE0F\uFE0F",
        "\u{1F600}\uFE0F\uFE0F",
      ];
      const rows = names.map((name) => {
        const path = `/data/${name}.md`;
        let refused = false;
        try {
          assertPlainPath(path, "path");
        } catch {
          refused = true;
        }
        const shown = summarizeCall({ path }).summary.path as string;
        return { name, refused, marked: /⟨U\+(200D|FE0E|FE0F)⟩/.test(shown) };
      });
      expect(rows.filter((row) => row.refused !== row.marked)).toEqual([]);
      // Both directions are exercised, or the comparison proves nothing.
      expect(rows.some((row) => row.refused)).toBe(true);
      expect(rows.some((row) => !row.refused)).toBe(true);
    });

    // Seventh review of #1242: U+200C was refused and marked everywhere, and
    // U+200D outside an emoji, although in Arabic-script and Indic text they
    // shape what you see. All three read them through one rule (RFC 5892
    // CONTEXTJ, in `emoji-sequence.ts`): the path check and the recipient
    // check refuse a joiner exactly where the card marks it.
    it("the card marks a joiner exactly where the path and recipient checks refuse it", () => {
      const names = [
        "گزارش\u200Cها",
        "علی\u200Cرضا",
        "مِ\u200Cها",
        "محمد\u200Cرضا",
        "گزارش\u200C",
        "ش\u200Cء",
        "ش\u200Dه",
        "ශ්\u200Dරී",
        "അവന്\u200D",
        "क्\u200Cष",
        "क\u093C\u200Cष",
        "जगत्\u200C",
        "a्\u200Cb",
        "क्\u200Cb",
        "a\u200Cb",
        "Ad\u200Da",
        // Ninth review of #1242: a word-final ZWJ after a virama draws nothing
        // in Tamil or Thai, and the Bengali ya-phalaa after ra carries one
        // before the virama.
        "தமிழ்\u200D",
        "ก\u0E3A\u200D",
        "ग्\u200D",
        "ट्\u200D",
        "র\u200D্যাংকিং",
        "ৰ\u200D্য",
        "ক\u200D্য",
      ];
      const rows = names.map((name) => {
        const path = `/data/${name}.md`;
        let pathRefused = false;
        try {
          assertPlainPath(path, "path");
        } catch {
          pathRefused = true;
        }
        const recipient = `${name} <x@example.com>`;
        const shownPath = summarizeCall({ path }).summary.path as string;
        const shownTo = summarizeCall({ to: recipient }).summary.to as string;
        return {
          name,
          pathRefused,
          pathMarked: /⟨U\+200[CD]⟩/.test(shownPath),
          recipientRefused: !parseSingleRecipient(recipient).ok,
          recipientMarked: /⟨U\+200[CD]⟩/.test(shownTo),
        };
      });
      expect(rows.filter((row) => row.pathRefused !== row.pathMarked)).toEqual([]);
      // A display name may carry U+200D anywhere (`isEmojiFormatChar`): the
      // card marks it where it renders as nothing. U+200C has no such
      // allowance, so for it the two must agree exactly.
      expect(
        rows.filter(
          (row) => row.name.includes("\u200C") && row.recipientRefused !== row.recipientMarked
        )
      ).toEqual([]);
      expect(rows.filter((row) => row.recipientRefused && !row.recipientMarked)).toEqual([]);
      // Both directions are exercised, or the comparison proves nothing.
      expect(rows.some((row) => row.pathRefused)).toBe(true);
      expect(rows.some((row) => !row.pathRefused)).toBe(true);
      expect(rows.some((row) => row.recipientRefused)).toBe(true);
      expect(rows.some((row) => !row.recipientRefused && row.name.includes("\u200C"))).toBe(true);
      // The ninth review's names, by name: the agreement above would hold
      // just as well if all three accepted them.
      const refusedNames = rows.filter((row) => row.pathRefused).map((row) => row.name);
      expect(refusedNames).toEqual(
        expect.arrayContaining(["தமிழ்\u200D", "ก\u0E3A\u200D", "ट्\u200D", "ক\u200D্য"])
      );
      expect(rows.filter((row) => !row.pathRefused).map((row) => row.name)).toEqual(
        expect.arrayContaining(["ग्\u200D", "র\u200D্যাংকিং", "ৰ\u200D্য"])
      );
    });

    it("a path may carry exactly the space separators, and the card marks every one", () => {
      const allowed = every(isSpaceSeparator);
      expect(allowed).toEqual(every((char) => char !== " " && /^\p{Zs}$/u.test(char)));
      expect(allowed).toContain(0x00a0);
      expect(allowed).toContain(0x202f);
      for (const cp of allowed) {
        const char = String.fromCodePoint(cp);
        expect(hiddenCharIn(char)).not.toBeNull();
        expect(hiddenCharIn(char, isSpaceSeparator)).toBeNull();
        // Visible on the card as a ⟨U+XXXX⟩ marker, never as blank space.
        expect(isEscapedChar(char)).toBe(true);
      }
    });

    // Ninth review of #1242: a display name refused every space separator, so
    // a Japanese name written with an ideographic space could not be mailed.
    // One is allowed now, as in a path, because the card marks it; a run of
    // them is still blank space, and still refused.
    it("a display name may carry a single space separator, and the card marks it", () => {
      for (const cp of every(isSpaceSeparator)) {
        const char = String.fromCodePoint(cp);
        const marker = `⟨U+${cp.toString(16).toUpperCase().padStart(4, "0")}⟩`;
        const recipient = `"Ada${char}Lovelace" <ada@example.com>`;
        expect(parseSingleRecipient(recipient).ok, marker).toBe(true);
        expect(summarizeCall({ to: recipient }).summary.to as string).toContain(marker);
        expect(parseSingleRecipient(`"Ada${char}${char}Lovelace" <ada@example.com>`).ok).toBe(
          false
        );
        expect(parseSingleRecipient(`"Ada ${char}Lovelace" <ada@example.com>`).ok).toBe(false);
      }
    });
  });
});
