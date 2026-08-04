/**
 * Single source of truth for how e2e/email/ is partitioned between the two
 * Playwright configs that share it:
 *
 * - playwright.imap.config.ts claims exactly these specs (testMatch) — they
 *   need the GreenMail + imap-mock stack (docker-compose.imap-test.yml) that
 *   the OAuth-provider job does not bring up.
 * - playwright.email.config.ts ignores exactly these specs (testIgnore) and
 *   runs everything else in e2e/email by default.
 *
 * A spec listed here is claimed by imap and ignored by email; a spec NOT
 * listed here runs under email by default (the email config is a denylist).
 * Both configs import from this module, so there is no second list to keep
 * in sync by hand. See AGENTS.md, "A Hand-Maintained List That Mirrors Code
 * Will Be Wrong".
 */
export const IMAP_ONLY_SPEC_FILES = ["email-imap.spec.ts", "inbox-sweep.spec.ts"] as const;

/**
 * Escape a literal file name for embedding in a RegExp. A derived pattern must
 * escape what it derives from: an unescaped `.` matches any character, so a
 * future `email-imap.v2.spec.ts` would silently widen the allowlist to specs
 * nobody listed here — and a widened testMatch claims a spec the email config
 * still runs, so it runs twice rather than nowhere.
 */
function escapeForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * RegExp form for playwright.imap.config.ts's testMatch, derived from the list
 * above. Playwright tests this against a file path, so the alternation is
 * anchored to a whole path segment: it matches `<anything>/inbox-sweep.spec.ts`
 * and nothing that merely contains that name.
 */
export const IMAP_ONLY_SPEC_MATCH = new RegExp(
  `(?:^|/)(?:${IMAP_ONLY_SPEC_FILES.map(escapeForRegExp).join("|")})$`
);
