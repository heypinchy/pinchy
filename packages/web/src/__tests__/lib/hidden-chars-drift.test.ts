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
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { isEscapedChar, summarizeCall } from "@/lib/approvals/summary";
import {
  hiddenCharIn,
  isEmojiFormatChar,
  isJoiner,
  isSpaceSeparator,
} from "../../../../plugins/pinchy-email/hidden-chars";
import { assertPlainPath } from "../../../../plugins/pinchy-files/plain-path";
import { parseSingleRecipient } from "../../../../plugins/pinchy-email/recipient";

const copiesOf = (file: string) =>
  ["pinchy-email", "pinchy-files"].map((plugin) =>
    resolve(import.meta.dirname, `../../../../plugins/${plugin}/${file}`)
  );
const COPIES = copiesOf("hidden-chars.ts");

/** Kept readable by the summary on purpose: layout (tab, line break) and the
 * four format characters of ordinary emoji, which cannot carry a payload. The
 * card marks those four wherever they are not part of a full RGI emoji
 * (`emoji-sequence.ts`). */
const SUMMARY_KEEPS = new Set([0x09, 0x0a, 0x200c, 0x200d, 0xfe0e, 0xfe0f]);

describe("hidden-chars drift guard", () => {
  it("is identical in every plugin that carries it", () => {
    const [first, ...rest] = COPIES.map((file) => readFileSync(file, "utf8"));
    expect(first).toContain("export function hiddenCharIn(");
    for (const copy of rest) expect(copy).toBe(first);
  });

  // Seventh review of #1242 gave pinchy-email a copy of the joiner rule.
  // Tenth review: a display name accepts every joiner and the card marks it,
  // so the recipient check no longer asks where one draws something. One copy
  // is left, and the path check and the card both read it — a second copy
  // would be a second rule.
  it("the path check and the card read the one copy of the emoji rule", () => {
    const [emailCopy, filesCopy] = copiesOf("emoji-sequence.ts");
    expect(existsSync(emailCopy)).toBe(false);
    expect(readFileSync(filesCopy, "utf8")).toContain("export function markedFormatOffsets(");
    const pathCheck = readFileSync(copiesOf("plain-path.ts")[1], "utf8");
    expect(pathCheck).toContain('import { markedFormatOffsets } from "./emoji-sequence";');
    const card = readFileSync(
      resolve(import.meta.dirname, "../../lib/approvals/summary.ts"),
      "utf8"
    );
    expect(card).toContain(
      'import { markedFormatOffsets } from "../../../../plugins/pinchy-files/emoji-sequence";'
    );
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
    // written. The card shows these characters as they are inside a full RGI
    // emoji, so a path may carry them there. Elsewhere a presentation selector
    // stays refused — `report⟨U+FE0F⟩.md` — while a joiner is accepted and
    // marked (tenth review), as `isJoiner` pins below.
    it("a path may carry a selector inside an emoji and nowhere else, and a joiner anywhere", () => {
      // No RGI emoji carries U+FE0E: Unicode's list is of emoji presentation.
      const inEmoji: Record<string, string | undefined> = {
        "\u200D": "\u{1F468}\u200D\u{1F469}\u200D\u{1F467}",
        "\uFE0F": "\u26A0\uFE0F",
      };
      for (const cp of every(isEmojiFormatChar)) {
        const char = String.fromCodePoint(cp);
        const emoji = inEmoji[char];
        if (emoji) expect(() => assertPlainPath(`/data/${emoji} x.md`, "path")).not.toThrow();
        else expect(() => assertPlainPath(`/data/\u26A0${char} x.md`, "path")).toThrow(/U\+/);
        if (isJoiner(char)) {
          expect(() => assertPlainPath(`/data/a${char}b.md`, "path")).not.toThrow();
        } else {
          expect(() => assertPlainPath(`/data/a${char}b.md`, "path")).toThrow(/U\+/);
        }
      }
    });

    // Sixth review of #1242: the card kept the joiner and the presentation
    // selectors raw everywhere, so a stray one read as nothing on the card
    // while the path rule refused it. Both now read emoji through one module
    // (pinchy-files `emoji-sequence.ts`); pinned here so they cannot drift:
    // the card marks a presentation selector exactly where a path may not
    // carry it.
    it("the card marks a selector in a path exactly where the path rule refuses it", () => {
      const names = [
        "⚠️ offen",
        "⚠︎ text",
        "✅ done",
        "✅️ done",
        "✅︎ done",
        "\u{1F4C4}️",
        "\u{1F468}‍\u{1F469}‍\u{1F467}",
        "\u{1F469}\u{1F3FD}‍\u{1F4BB}",
        "\u{1F3F3}️‍\u{1F308}",
        "\u{1F3F3}‍\u{1F308}",
        "❤️‍\u{1F525}",
        "1️⃣ first",
        "report️",
        "⚠️️",
        "\u{1F600}️️",
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
        return { name, refused, marked: /⟨U\+(FE0E|FE0F)⟩/.test(shown) };
      });
      expect(rows.filter((row) => row.refused !== row.marked)).toEqual([]);
      // Both directions are exercised, or the comparison proves nothing.
      expect(rows.some((row) => row.refused)).toBe(true);
      expect(rows.some((row) => !row.refused)).toBe(true);
    });

    // Seventh to ninth review of #1242 kept a joiner raw where a per-script
    // rule said it shapes the text; the tenth found the rule let through
    // joiners that draw nothing (Tamil க்‌ம, Thai กฺ‍ม, Myanmar က်‍မ, Sinhala
    // ක්‍ම, Gurmukhi ਕ੍‍ਮ, and 📄‍📄). One rule now: the path check and the
    // recipient check accept a joiner anywhere, and the card — for a path and
    // a recipient alike — shows it raw only inside a full RGI emoji.
    it("the card marks a joiner in a path and a recipient exactly outside an RGI emoji", () => {
      const raw = [
        "\u{1F468}‍\u{1F469}‍\u{1F467}",
        "\u{1F3F3}️‍\u{1F308}",
        "\u{1F469}\u{1F3FD}‍\u{1F4BB}",
        "❤️‍\u{1F525}",
      ];
      const marked = [
        "گزارش‌ها",
        "علی‌رضا",
        "مِ‌ها",
        "محمد‌رضا",
        "گزارش‌",
        "ش‌ء",
        "ش‍ه",
        "ශ්‍රී",
        "അവന്‍",
        "क्‌ष",
        "क़‌ष",
        "जगत्‌",
        "a्‌b",
        "क्‌b",
        "a‌b",
        "Ad‍a",
        "தமிழ்‍",
        "กฺ‍",
        "ग्‍",
        "ट्‍",
        "র‍্যাংকিং",
        "ৰ‍্য",
        "ক‍্য",
        // Tenth review of #1242: mid-word, after a virama and before a letter
        // of its own script — each pixel-identical to the name without the
        // joiner in a shipping font.
        "க்‌ம",
        "க்‍ம",
        "กฺ‍ม",
        "က်‍မ",
        "ක්‍ම",
        "ਕ੍‍ਮ",
        "ക്‌മ",
        "ક્‍મ",
        "क्‍म",
        // …and pictographs joined into no RGI emoji.
        "\u{1F4C4}‍\u{1F4C4}",
        "❤‍\u{1F525}",
        "\u{1F468}‍\u{1F469}‍\u{1F467}‍\u{1F4C4}",
      ];
      const rows = [...raw, ...marked].map((name) => {
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
          recipientRefused: !parseSingleRecipient(recipient).ok,
          pathMarked: /⟨U\+200[CD]⟩/.test(shownPath),
          recipientMarked: /⟨U\+200[CD]⟩/.test(shownTo),
        };
      });
      expect(rows.filter((row) => row.pathRefused || row.recipientRefused)).toEqual([]);
      // One predicate behind both: a path and a recipient never disagree.
      expect(rows.filter((row) => row.pathMarked !== row.recipientMarked)).toEqual([]);
      expect(rows.filter((row) => row.pathMarked).map((row) => row.name)).toEqual(marked);
    });

    it("a path and a display name may carry exactly the two joiners, and the card marks a lone one", () => {
      const allowed = every(isJoiner);
      expect(allowed).toEqual([0x200c, 0x200d]);
      for (const cp of allowed) {
        const char = String.fromCodePoint(cp);
        const marker = `⟨U+${cp.toString(16).toUpperCase()}⟩`;
        expect(hiddenCharIn(char)).not.toBeNull();
        expect(hiddenCharIn(char, isJoiner)).toBeNull();
        expect(() => assertPlainPath(`/data/a${char}b.md`, "path")).not.toThrow();
        expect(parseSingleRecipient(`Ada${char}Lovelace <ada@example.com>`).ok).toBe(true);
        expect(summarizeCall({ path: `/data/a${char}b.md` }).summary.path).toBe(
          `/data/a${marker}b.md`
        );
      }
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
