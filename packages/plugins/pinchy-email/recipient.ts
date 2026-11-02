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

export type ParsedRecipient = { ok: true; address: string } | { ok: false; error: string };

// Control characters, invisible format characters (zero-width, bidi overrides),
// and line/paragraph separators. None belongs in an address, and bidi
// overrides can make one address read as another.
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

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
  if (FORBIDDEN.test(text)) {
    return {
      ok: false,
      error: `Invalid recipient: it contains a control or invisible character. ${ONLY_ONE}`,
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
    const name = named[1].replace(/\s+/g, " ").trim();
    return { ok: true, address: name ? `${name} <${named[2]}>` : named[2] };
  }
  return { ok: false, error: `Invalid recipient: it is not a single plain address. ${ONLY_ONE}` };
}
