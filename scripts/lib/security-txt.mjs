/**
 * Guard for the published `security.txt` (RFC 9116).
 *
 * A `security.txt` is the file a scanner or a researcher reads BEFORE writing
 * to us, so it decides whether a real report reaches the right inbox. Its
 * failure mode is unusual and worth stating plainly: RFC 9116 makes `Expires`
 * mandatory, and a file past that date is not "slightly stale" — it is
 * **invalid**, to be treated as though it were not there. So the file rots on a
 * timer, on its own, with no commit to notice and nothing in the repo looking
 * any different. That is the same shape as a check that stops checking: green
 * everywhere, protecting nobody.
 *
 * Hence the deliberately time-dependent test alongside this module. It fails
 * RENEWAL_WINDOW_DAYS *before* the published file stops being honoured, so the
 * renewal lands as an ordinary red CI run someone fixes in a minute, rather
 * than as a silence nobody hears. A guard that only fired after expiry would
 * report the outage, not prevent it.
 *
 * The remaining rules all guard the same thing from other angles — a file that
 * looks fine in the repo and is refused, or ignored, out on the wire:
 *   - `Expires` must stay under a year (§2.5.5). A ten-year date would silence
 *     the alarm above while making the contact details unfalsifiable.
 *   - `Expires` must be a real RFC 3339 timestamp, checked by pattern rather
 *     than by `new Date()`, which accepts several forms no reader does.
 *   - Every `mailto:` Contact must be an address SECURITY.md actually names.
 *     The two files are edited months apart and each looks complete on its
 *     own; a reporter routed to a dead alias gets no answer and concludes we
 *     do not care. Same paired-list drift the other guards in here cover.
 *   - `Policy:` must resolve to a file that exists here. Nothing else looks at
 *     it: lychee reads `.md`, never a `.txt`.
 *
 * THERE ARE TWO PUBLISHED COPIES, AND ONLY ONE OF THEM IS GUARDED HERE.
 * This module validates the docs.heypinchy.com file that lives in this repo.
 * heypinchy.com — the domain people actually write to — carries its own copy
 * in the separate, private website repo (heypinchy/website,
 * `public/.well-known/security.txt`), which has no equivalent harness. Both
 * were published with the same `Expires`, so when this alarm goes off, RENEW
 * BOTH. Renewing only this one leaves the alarm quiet and the more important
 * file expired, which is strictly worse than the gap this guard closed.
 *
 * The `canonical` argument is what keeps a copy-paste between the two honest.
 */

/** Fail this many days before `Expires`, so the renewal has room to happen. */
export const RENEWAL_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;
const MAX_VALIDITY_DAYS = 365;

/**
 * RFC 3339 date-time, which is the format §2.5.5 requires of `Expires`.
 *
 * Checked with a pattern rather than by handing the string to `new Date()`,
 * because `Date` is far more generous than any security.txt reader: it accepts
 * `2027-01-31`, `Jan 31 2027`, and even a bare `2027` (silently January 1st).
 * Each is a file a scanner rejects outright, so parsing alone would wave
 * through precisely the invisible invalidity this module exists to catch. The
 * two zone-less forms are also parsed as *local* time, which would put a
 * Vienna laptop and a UTC runner an hour apart at the edge of the renewal
 * window.
 */
const RFC3339 =
  /^(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})[Tt]\d{2}:\d{2}:\d{2}(\.\d+)?([Zz]|[+-]\d{2}:\d{2})$/;

/**
 * Whether a matched `Expires` names a day the calendar actually has.
 *
 * A separate check because `Date` rolls over instead of refusing: it turns
 * `2027-02-31` into March 3rd, so parsing alone reports success on a value a
 * strict reader rejects — the same silent invalidity as a malformed date, just
 * quieter.
 *
 * @param {{ year: string, month: string, day: string }} groups
 */
function isRealCalendarDay({ year, month, day }) {
  const probe = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  return (
    probe.getUTCFullYear() === Number(year) &&
    probe.getUTCMonth() === Number(month) - 1 &&
    probe.getUTCDate() === Number(day)
  );
}

/**
 * `Policy:` values are pinned to a blob URL on main so the target can be
 * resolved to a path in this checkout and checked for existence.
 */
const POLICY_BLOB_PREFIX = "https://github.com/heypinchy/pinchy/blob/main/";

/**
 * Parse the `field: value` grammar of RFC 9116 §2.
 *
 * Field names are case-insensitive (§2.2) and may repeat, so values collect
 * into an array per lowercased name. `#` comment lines and blank lines are
 * dropped.
 *
 * @param {string} content
 * @returns {Map<string, string[]>}
 */
function parseFields(content) {
  const fields = new Map();
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;

    const separator = trimmed.indexOf(":");
    if (separator === -1) continue;

    const name = trimmed.slice(0, separator).trim().toLowerCase();
    const value = trimmed.slice(separator + 1).trim();
    const existing = fields.get(name);
    if (existing) existing.push(value);
    else fields.set(name, [value]);
  }
  return fields;
}

/**
 * @param {string} content the security.txt file
 * @param {{ now: Date, canonical: string }} options
 * @returns {string[]} problems (empty = ok)
 */
export function validateSecurityTxt(content, { now, canonical }) {
  const fields = parseFields(content);
  const problems = [];

  if (!fields.has("contact")) {
    problems.push(
      "security.txt needs a `Contact:` field (RFC 9116 §2.5.3) — without one the file tells a reporter nothing",
    );
  }

  problems.push(...validateExpires(fields.get("expires"), now));

  const canonicals = fields.get("canonical");
  if (!canonicals) {
    problems.push(
      `security.txt needs a \`Canonical: ${canonical}\` field — it is what binds the file to the domain it was fetched from`,
    );
  } else if (!canonicals.includes(canonical)) {
    problems.push(
      `\`Canonical\` must list ${canonical} (got ${canonicals.join(", ")})`,
    );
  }

  if (!fields.has("policy")) {
    problems.push(
      "security.txt needs a `Policy:` field — it is what carries our answer on paid bounties, and dropping it invites the negotiation the policy exists to refuse",
    );
  }

  return problems;
}

/**
 * The repo-relative path a `Policy:` value points at, or `null` if it is not a
 * blob URL on main.
 *
 * Nothing else checks this link: lychee reads `.md`/`.mdx` and never opens a
 * `.txt`, so a renamed SECURITY.md would leave a 404 in the first file a
 * reporter looks at. Resolving the URL back to a path lets the test assert the
 * target still exists.
 *
 * @param {string} securityTxt
 * @returns {string | null}
 */
export function policyRepoPath(securityTxt) {
  const policy = parseFields(securityTxt).get("policy")?.[0];
  if (!policy?.startsWith(POLICY_BLOB_PREFIX)) return null;
  return policy.slice(POLICY_BLOB_PREFIX.length);
}

/**
 * @param {string[] | undefined} values
 * @param {Date} now
 * @returns {string[]}
 */
function validateExpires(values, now) {
  if (!values) {
    return [
      "security.txt needs an `Expires:` field (RFC 9116 §2.5.5) — it is mandatory, and a file without one is invalid",
    ];
  }
  if (values.length > 1) {
    // §2.5.5: a reader cannot resolve which of two dates governs, so the file
    // is invalid rather than generously interpreted.
    return [
      `\`Expires\` must appear exactly once (got ${values.length}: ${values.join(", ")})`,
    ];
  }

  const shape = RFC3339.exec(values[0]);
  if (!shape) {
    return [
      `\`Expires\` must be an RFC 3339 timestamp with a timezone, e.g. 2027-01-31T00:00:00.000Z (got "${values[0]}")`,
    ];
  }

  const expires = new Date(values[0]);
  if (Number.isNaN(expires.getTime()) || !isRealCalendarDay(shape.groups)) {
    return [`\`Expires\` names a day that does not exist (got "${values[0]}")`];
  }

  const daysLeft = (expires.getTime() - now.getTime()) / DAY_MS;
  if (daysLeft <= 0) {
    return [
      `security.txt EXPIRED on ${expires.toISOString()} — RFC 9116 readers treat an expired file as absent, so it is currently protecting nobody`,
    ];
  }
  if (daysLeft < RENEWAL_WINDOW_DAYS) {
    return [
      `security.txt expires ${expires.toISOString()} — within ${RENEWAL_WINDOW_DAYS} days. Renew it now, while it is still valid.`,
    ];
  }
  if (daysLeft > MAX_VALIDITY_DAYS) {
    return [
      `\`Expires\` is ${Math.round(daysLeft)} days out — RFC 9116 §2.5.5 asks for less than a year, and a distant date silences the renewal alarm`,
    ];
  }
  return [];
}

/**
 * Every `mailto:` Contact must be an address SECURITY.md actually names.
 *
 * Non-mailto contacts (a web form, a phone number) are exempt: only an address
 * can drift against the one SECURITY.md tells reporters to write to.
 *
 * @param {string} securityTxt
 * @param {string} securityMd
 * @returns {string[]} problems (empty = ok)
 */
export function validateContactParity(securityTxt, securityMd) {
  const contacts = parseFields(securityTxt).get("contact") ?? [];
  const problems = [];

  for (const contact of contacts) {
    if (!contact.toLowerCase().startsWith("mailto:")) continue;

    const address = contact.slice("mailto:".length).trim();
    if (!securityMd.toLowerCase().includes(address.toLowerCase())) {
      problems.push(
        `security.txt points reporters at ${address}, which SECURITY.md never mentions — one of the two is stale`,
      );
    }
  }
  return problems;
}
