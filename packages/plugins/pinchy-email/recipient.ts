/**
 * `email_send` / `email_draft` take exactly ONE recipient.
 *
 * The libraries behind them parse a recipient string as an address LIST:
 * nodemailer (SMTP) splits on commas, and Gmail receives the string as a raw
 * `To:` header. So `"chef@firma.at, angreifer@evil.com"` delivers to both — and
 * behind a few hundred spaces the second address is out of view of anyone
 * reading it. A prompt-injected agent (web page, inbound mail, KB document)
 * can therefore add a recipient the person approving never sees.
 *
 * The confirmation card now lists every address explicitly, but the tool is the
 * last line of defence: it accepts one address and refuses everything that
 * could be read as more than one. The model is told to send one mail per
 * recipient, which is also what the schema ("Recipient email address") says.
 */

import { invisibleFormatOffsets } from "./emoji-sequence.js";
import { hiddenCharIn, isEmojiFormatChar } from "./hidden-chars.js";

export type ParsedRecipient = { ok: true; address: string } | { ok: false; error: string };

/**
 * Longest display name accepted. A name is there to be recognised at a glance;
 * a long one is how a familiar name pushes the real address out of view.
 */
const MAX_NAME_LENGTH = 64;

// Characters that separate, group or comment an address in RFC 5322 syntax. If
// one is present the string is not one plain address. The emoji format
// characters a display name may carry are not part of any address either, nor
// is the zero-width non-joiner a Persian name may carry.
const PART = String.raw`[^\s@,;:<>()\[\]"\\\u200C\u200D\uFE0E\uFE0F]`;
const ADDRESS = `${PART}+@${PART}+`;
const BARE_ADDRESS = new RegExp(`^${ADDRESS}$`, "u");
// `"Display Name" <address>`: RFC 5322's quoted form, which is how a mail
// program writes a name with a comma or parentheses ("Müller, Hans"). Inside
// the quotes, only the characters that would make it more than a name are
// refused: `@` (that is how "boss@firma.at" <attacker@evil.com> would
// impersonate), a quote or backslash (escapes), and angle or square brackets.
const QUOTED_ADDRESS = new RegExp(`^"([^"\\\\@<>\\[\\]]*)"\\s?<(${ADDRESS})>$`, "u");
// `Display Name <address>`, unquoted.
const NAMED_ADDRESS = new RegExp(`^([^<>"]*)<(${ADDRESS})>$`, "u");
/** Characters a name may carry only inside double quotes. */
const NEEDS_QUOTES = /[,;:()]/;

// The characters that give an address its structure. Compatibility forms of
// them (fullwidth ＠ U+FF20, small-form ﹫ U+FE6B, fullwidth ，＜＞ …) are not
// separators to a mail library, but they READ as one — "boss＠firma.at
// <attacker@evil.com>" looks like the boss's address on the card. NFKC folds
// each compatibility form into the ASCII character it imitates, so any such
// character shows up as a structural character that was not there before.
const STRUCTURAL = /[@,;:<>()[\]"\\]/g;

function structure(text: string): string {
  return (text.match(STRUCTURAL) ?? []).join("");
}

const ONLY_ONE =
  "email_send and email_draft take exactly one recipient address in `to` (for example " +
  '"ada@example.com"). To reach several people, make one call per recipient — one recipient per call.';

/** The quoted form of a recipient, for an error that shows the fix. */
function quoted(name: string, address: string): string {
  return `"${name}" <${address}>`;
}

/**
 * `Name <address>`, quoting the name when it carries a character that would
 * otherwise be read as syntax — so the string the adapters receive parses as
 * the same single mailbox in every library.
 */
function mailbox(name: string, address: string): string {
  if (!name) return address;
  return NEEDS_QUOTES.test(name) ? quoted(name, address) : `${name} <${address}>`;
}

function checkName(name: string): string | null {
  if ([...name].length > MAX_NAME_LENGTH) {
    return (
      `Invalid recipient: the display name is longer than ${MAX_NAME_LENGTH} characters. ` +
      `Shorten it, or send to the bare address. ${ONLY_ONE}`
    );
  }
  return null;
}

/**
 * `text` with each lone space separator read as a plain space (ninth review of
 * #1242). A no-break or ideographic space takes visible width and is part of
 * real names — `"山田\u3000太郎" <yamada@example.jp>` — and the card prints it as
 * `⟨U+3000⟩`, as it does in a path. Next to another space of any kind it is
 * part of a run, which reads as empty space and pushes the address out of
 * view, so there it is left for `hiddenCharIn` to refuse.
 */
function withLoneSpaceSeparatorsAsSpaces(text: string): string {
  return text.replace(/(?<![ \p{Zs}])\p{Zs}(?![ \p{Zs}])/gu, " ");
}

/** `text` without the U+200C that shape it (`invisibleFormatOffsets`). */
function withoutShapingNonJoiners(text: string): string {
  const invisible = invisibleFormatOffsets(text, { redundant: false });
  return text.replace(/\u200C/g, (char: string, offset: number) =>
    invisible.has(offset) ? char : ""
  );
}

export function parseSingleRecipient(value: unknown): ParsedRecipient {
  if (typeof value !== "string") {
    return { ok: false, error: `Invalid recipient: ${ONLY_ONE}` };
  }
  const text = value.trim();
  if (text.length === 0 || text.length > 420) {
    return { ok: false, error: `Invalid recipient: ${ONLY_ONE}` };
  }
  // Controls, zero-width and bidi characters, and everything that renders as
  // blank space without being a plain space — the braille blank U+2800, Hangul
  // fillers, no-break and ideographic spaces. A run of them reads as empty
  // space and pushed the real address out of view on the confirmation card
  // (second review of #1242); bidi overrides make one address read as another.
  // The emoji format characters (ZWJ, VS15, VS16) are allowed here and kept
  // out of the address by PART: a name like "❤️ Team" is ordinary. So is a
  // zero-width non-joiner where it shapes the name — "علی‌رضا" keeps its ی
  // unjoined (seventh review of #1242) — but not where it renders as nothing,
  // which is where the card marks it (`emoji-sequence.ts`).
  // A single no-break or ideographic space is allowed too, as in a path; a run
  // of them is not (`withLoneSpaceSeparatorsAsSpaces`).
  const hidden = hiddenCharIn(
    withLoneSpaceSeparatorsAsSpaces(withoutShapingNonJoiners(text)),
    isEmojiFormatChar
  );
  if (hidden) {
    return {
      ok: false,
      error:
        `Invalid recipient: it contains an invisible or blank-rendering character (${hidden}), ` +
        `which would hide part of the address from the person confirming it. ${ONLY_ONE}`,
    };
  }
  if (/ {2}/.test(text)) {
    return {
      ok: false,
      error:
        "Invalid recipient: it contains a run of spaces, which would push part of the " +
        `address out of view. Use single spaces in a display name. ${ONLY_ONE}`,
    };
  }
  if (structure(text.normalize("NFKC")) !== structure(text)) {
    return {
      ok: false,
      error:
        "Invalid recipient: it contains a character that imitates an address separator " +
        `(such as a fullwidth "\uFF20" instead of "@"). ${ONLY_ONE}`,
    };
  }
  if (BARE_ADDRESS.test(text)) return { ok: true, address: text };

  const quotedName = QUOTED_ADDRESS.exec(text);
  if (quotedName) {
    const name = quotedName[1].trim();
    const tooLong = checkName(name);
    if (tooLong) return { ok: false, error: tooLong };
    return { ok: true, address: mailbox(name, quotedName[2]) };
  }

  const named = NAMED_ADDRESS.exec(text);
  if (named && !named[1].includes("@")) {
    const name = named[1].trim();
    // Unquoted, a comma or semicolon separates two recipients and parentheses
    // open a comment — so "Müller, Hans <hans@x.de>" is two mailboxes to a
    // mail library. The name is real; it only needs quotes. Say exactly that,
    // rather than the "one recipient per call" message, which would send the
    // model looking for a second recipient that is not there.
    if (/[,;]/.test(name)) {
      return {
        ok: false,
        error:
          "Invalid recipient: the display name contains a comma or semicolon, which a mail " +
          "program reads as the start of a second recipient. Put the name in double quotes: " +
          `${quoted(name, named[2])}`,
      };
    }
    if (/[()]/.test(name)) {
      return {
        ok: false,
        error:
          "Invalid recipient: the display name contains parentheses, which a mail program " +
          "reads as a comment rather than as part of the name. Put the name in double " +
          `quotes: ${quoted(name, named[2])}`,
      };
    }
    if (!/[:[\]\\]/.test(name)) {
      const tooLong = checkName(name);
      if (tooLong) return { ok: false, error: tooLong };
      return { ok: true, address: mailbox(name, named[2]) };
    }
  }
  return { ok: false, error: `Invalid recipient: it is not a single plain address. ${ONLY_ONE}` };
}

/**
 * Splits a recipient `parseSingleRecipient` accepted into its display name and
 * address. The adapters hand the two to their mail API separately (Graph's
 * `emailAddress.{name,address}`, nodemailer's `{ name, address }`, an RFC 2047
 * encoded-word for Gmail's raw header) rather than passing `Name <address>` on
 * as one string for each library to re-parse its own way.
 */
export function splitMailbox(recipient: string): { name?: string; address: string } {
  const named = /^([^<>]*)<([^<>]+)>$/.exec(recipient.trim());
  if (!named) return { address: recipient.trim() };
  let name = named[1].trim();
  // `parseSingleRecipient` quotes a name that carries a comma or parentheses
  // and never lets a quote or backslash inside, so unquoting is just this.
  if (name.length >= 2 && name.startsWith('"') && name.endsWith('"')) {
    name = name.slice(1, -1).trim();
  }
  const address = named[2].trim();
  return name ? { name, address } : { address };
}
