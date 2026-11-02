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

import { hiddenCharIn } from "./hidden-chars.js";

export type ParsedRecipient = { ok: true; address: string } | { ok: false; error: string };

/**
 * Longest display name accepted. A name is there to be recognised at a glance;
 * a long one is how a familiar name pushes the real address out of view.
 */
const MAX_NAME_LENGTH = 64;

// Characters that separate, group or comment an address in RFC 5322 syntax. If
// one is present the string is not one plain address.
const PART = String.raw`[^\s@,;:<>()\[\]"\\]`;
const BARE_ADDRESS = new RegExp(`^${PART}+@${PART}+$`, "u");
// `Display Name <address>`; the display name may not itself contain an `@`
// (that is how "boss@firma.at <attacker@evil.com>" would impersonate).
const NAMED_ADDRESS = new RegExp(`^([^<>@,;:()\\[\\]"\\\\]*)<(${PART}+@${PART}+)>$`, "u");

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
  const hidden = hiddenCharIn(text);
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

  const named = NAMED_ADDRESS.exec(text);
  if (named) {
    const name = named[1].trim();
    if ([...name].length > MAX_NAME_LENGTH) {
      return {
        ok: false,
        error:
          `Invalid recipient: the display name is longer than ${MAX_NAME_LENGTH} characters. ` +
          `Shorten it, or send to the bare address. ${ONLY_ONE}`,
      };
    }
    return { ok: true, address: name ? `${name} <${named[2]}>` : named[2] };
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
  const name = named[1].trim();
  const address = named[2].trim();
  return name ? { name, address } : { address };
}
