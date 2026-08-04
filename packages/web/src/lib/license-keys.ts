/**
 * The license material this build ships: the public keys a license may be
 * verified against, and the development license itself.
 *
 * Kept in a module of its own, with no imports, so the guards in
 * `__tests__/security/committed-license-tokens.test.ts` can read the
 * production key without pulling in `@/lib/settings` (and with it the DB).
 *
 * See AGENTS.md § "Secret Handling" — none of this is secret. A public key is
 * public by construction, and the development token below unlocks nothing that
 * a production install honours (#1083).
 */

/**
 * Production public key (ES256 / P-256).
 * Generated with: npx tsx scripts/generate-license.ts --generate-keypair
 *
 * The matching private key is held by us and appears nowhere in this
 * repository. Every customer license verifies against this key.
 */
export const PRODUCTION_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEaPYaiLnn7Z+EUywhGX4vOitboyzJ
ce3W+NnSsTlbVzMRnXALwqra86Orhk9Sl4UWKEuebwltk+3OIuVy33oTWA==
-----END PUBLIC KEY-----`;

/**
 * Development public key (ES256 / P-256).
 *
 * Trusted ONLY outside production — see `developmentLicensesHonoured` in
 * `@/lib/enterprise`. This is the structural half of the fix for #1083: the
 * dev license a self-hoster can lift out of this repository is signed by a key
 * their install does not trust, so pasting it into Settings → License does
 * nothing.
 *
 * The matching private key is deliberately NOT committed. Nothing at runtime
 * needs it, and a private key in the tree is the shape of the bug this replaces.
 * To mint a new development license (the current one runs to 2126, so this
 * should stay theoretical):
 *
 *   npx tsx scripts/generate-license.ts --generate-keypair > /tmp/dev-license.pem
 *   PINCHY_LICENSE_PRIVATE_KEY="$(cat /tmp/dev-license.pem)" \
 *     npx tsx scripts/generate-license.ts --org pinchy-dev --type paid --days 36500
 *
 * Then replace this key, replace `DEV_LICENSE_TOKEN` below, and replace the
 * `PINCHY_ENTERPRISE_KEY` default in `docker-compose.dev.yml` — the drift guard
 * in `__tests__/security/committed-license-tokens.test.ts` fails if the last
 * one is forgotten.
 */
export const DEVELOPMENT_PUBLIC_KEY = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEP8GjpWN6BapAFGpJWt4aYZcHrSxE
ZBn4RRZ7nTILUQ33aQER5Atgmpj3p6NfI78KwcAw+CkrgcZ/1skRdvmhhQ==
-----END PUBLIC KEY-----`;

/**
 * The development license, signed by the development key above and issued to
 * `DEV_LICENSE_SUBJECT`. Unlocks enterprise features on a developer's own
 * stack and nowhere else.
 *
 * `docker-compose.dev.yml` ships the same string as the `PINCHY_ENTERPRISE_KEY`
 * default; Compose cannot import, so that copy is pinned by a drift guard
 * rather than by the type system.
 */
export const DEV_LICENSE_TOKEN =
  "eyJhbGciOiJFUzI1NiJ9.eyJ0eXBlIjoicGFpZCIsImZlYXR1cmVzIjpbImVudGVycHJpc2UiXSwiaXNzIjoiaGV5cGluY2h5LmNvbSIsInN1YiI6InBpbmNoeS1kZXYiLCJpYXQiOjE3NzM0ODUyMzQsImV4cCI6NDkyNzA4NTIzNH0.x6YibNzmaMdiWJb4GjksKqfvJ1y-Tu0cv-iSZWdPW5fPQIzzJyed4b8oMlBbdQN_CkRFOisjYe9Q75PC6OEZxA";
