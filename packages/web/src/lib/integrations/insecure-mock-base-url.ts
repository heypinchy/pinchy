/**
 * The web app's half of the insecure-mock seam.
 *
 * Four env vars let the E2E stacks redirect Google/Microsoft traffic to a local
 * mock server: `GMAIL_OAUTH_BASE_URL`, `MICROSOFT_OAUTH_BASE_URL`,
 * `GMAIL_API_BASE_URL` and `GRAPH_API_BASE_URL`. Pinchy — not OpenClaw — is the
 * process that holds the OAuth client secret and the refresh tokens and runs the
 * token exchange, so a stray override here redirects strictly more than the
 * plugin-side equivalents do: an access token expires, a client secret and a
 * refresh token do not.
 *
 * So the override only fires alongside an explicit `PINCHY_INSECURE_MAIL_MOCK=1`
 * opt-in, exactly as the plugin-side seams do (`imap-adapter.ts`, and
 * `resolveInsecureMockBaseUrl` in `pinchy-email/email-adapter.ts`). Without the
 * flag the override is ignored, the caller falls back to the real host, and a
 * one-time warning names the var so a leftover override is visible in the logs
 * instead of silently rerouting credentials.
 *
 * Deliberately duplicated rather than imported from the plugin package: the web
 * app does not depend on `packages/plugins/*`, and an import that reached across
 * that boundary would drag plugin code into the Next.js bundle graph.
 * `insecure-mock-override-coverage.test.ts` is what keeps the two halves from
 * drifting apart in coverage.
 */

/** The single opt-in flag for every mail/OAuth mock redirect on the web side. */
export const INSECURE_MAIL_MOCK_FLAG = "PINCHY_INSECURE_MAIL_MOCK";

/**
 * Override vars this module governs. The coverage guard reads this list, so an
 * override var that is added to the code and not to this list fails CI.
 */
export const INSECURE_MOCK_OVERRIDE_VARS = [
  "GMAIL_OAUTH_BASE_URL",
  "MICROSOFT_OAUTH_BASE_URL",
  "GMAIL_API_BASE_URL",
  "GRAPH_API_BASE_URL",
] as const;

export type InsecureMockOverrideVar = (typeof INSECURE_MOCK_OVERRIDE_VARS)[number];

// Which override vars we have already warned about in this process, so a
// leftover override doesn't spam the log on every refresh, probe or sweep.
const warnedMockOverrides = new Set<string>();

/**
 * Returns `overrideVar`'s value, but ONLY when `PINCHY_INSECURE_MAIL_MOCK` is
 * explicitly `"1"`. Returns undefined otherwise, so callers keep their real
 * production host as the `??` fallback.
 */
export function resolveInsecureMockBaseUrl(
  overrideVar: InsecureMockOverrideVar
): string | undefined {
  const override = process.env[overrideVar];
  if (!override) return undefined;
  if (process.env[INSECURE_MAIL_MOCK_FLAG] === "1") return override;
  if (!warnedMockOverrides.has(overrideVar)) {
    warnedMockOverrides.add(overrideVar);
    console.warn(
      `[pinchy] ${overrideVar} is set but ${INSECURE_MAIL_MOCK_FLAG} is not "1" — ignoring it ` +
        `and using the real host. If this is a test/mock stack, also set ` +
        `${INSECURE_MAIL_MOCK_FLAG}=1.`
    );
  }
  return undefined;
}

/**
 * Test-only: clears the warn-once dedupe so a test can assert the warning fires
 * again after resetting env stubs.
 */
export function resetInsecureMockWarningsForTest(): void {
  warnedMockOverrides.clear();
}
