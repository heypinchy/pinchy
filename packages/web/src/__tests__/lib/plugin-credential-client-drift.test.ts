/**
 * Drift guard: `credential-client.ts` is duplicated, byte-for-byte, into
 * pinchy-odoo, pinchy-email and pinchy-web.
 *
 * The duplication is forced, not sloppy. Each plugin directory is mounted
 * into the OpenClaw container standalone
 * (`./packages/plugins/<name>:/root/.openclaw/extensions/<name>`), so an
 * import that escapes the plugin directory resolves to a path that is not
 * there at runtime — the same bundle-isolation shape `normalizeTableHtml`
 * has, and it gets the same answer: duplicate the source, guard the copies.
 *
 * Without a guard the copies drift, and we know that because they already
 * had (#1077): three hand-maintained auth-error matchers, three cache-key
 * conventions, and a substring test for "401" in all three that read an Odoo
 * record id, an invoice amount and a 401(k) plan as "the credentials are
 * stale" — then flipped the connection to auth_failed over it.
 *
 * Byte-identical is deliberate rather than "identical modulo comments": there
 * is no legitimate reason for one plugin's copy to differ, and the comments
 * carry the reasoning that keeps the next editor from re-narrowing the
 * classifier. To change the module, edit the pinchy-odoo copy and copy it
 * over the other two.
 *
 * NOTE ON COVERAGE: the module's unit tests live once, in
 * `packages/plugins/pinchy-odoo/__tests__/credential-client.test.ts`. They
 * count as coverage for all three copies only for as long as THIS test
 * passes.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PLUGINS_DIR = resolve(import.meta.dirname, "../../../../plugins");
const REFERENCE_PLUGIN = "pinchy-odoo";

// Discovered, not listed. A literal list is a gate that reports on what it
// looks at rather than on what it should: the fourth plugin to copy
// credential-client.ts would drift unwatched while this file stayed green —
// the failure shape AGENTS.md names in § "A Hand-Maintained List That Mirrors
// Code Will Be Wrong". The floor below is what keeps a broken walk from
// passing on an empty corpus.
const PLUGINS_WITH_A_COPY = readdirSync(PLUGINS_DIR)
  .filter((entry) => entry.startsWith("pinchy-"))
  .filter((plugin) => existsSync(resolve(PLUGINS_DIR, plugin, "credential-client.ts")))
  .sort();

const COPY_PLUGINS = PLUGINS_WITH_A_COPY.filter((plugin) => plugin !== REFERENCE_PLUGIN);

function readCopy(plugin: string): string {
  return readFileSync(resolve(PLUGINS_DIR, plugin, "credential-client.ts"), "utf-8");
}

describe("credential-client drift guard", () => {
  const reference = readCopy(REFERENCE_PLUGIN);

  it("finds every plugin that carries a copy, including ones added later", () => {
    // Asserted against the plugins known to carry a copy rather than against
    // the length of a literal defined above — the latter is a tautology that
    // a typo'd path would not fail. Adding a copy to a fourth plugin should
    // extend this list; it must never shrink silently.
    expect(PLUGINS_WITH_A_COPY).toEqual(
      expect.arrayContaining(["pinchy-email", "pinchy-odoo", "pinchy-web"])
    );
    expect(COPY_PLUGINS.length).toBeGreaterThanOrEqual(2);
  });

  it("the reference copy is not empty and exports the shared surface", () => {
    // A guard that compares three unreadable files to each other passes on an
    // empty corpus. Pin what the module is actually expected to contain.
    for (const symbol of [
      "export class CredentialsFetchError",
      "export function credentialCacheKey",
      "export function authErrorStatus",
      "export function isAuthError",
      "export async function requestCredentials",
      "export async function postAuthFailure",
      "export function trackMutations",
    ]) {
      expect(reference).toContain(symbol);
    }
  });

  it.each(COPY_PLUGINS)("%s carries a byte-identical copy", (plugin) => {
    expect(readCopy(plugin)).toBe(reference);
  });

  it("no plugin classifies an auth error on its own", () => {
    // The point of the shared module is that there is ONE classifier. A
    // plugin that grows a second one in its index.ts is exactly the drift
    // #1077 reported, and the byte-comparison above cannot see it.
    //
    // Two narrow checks rather than one broad one. A regex over auth-ish
    // words would also flag `isOdooAccessError`, which decides what error
    // MESSAGE to show the model and never gates a retry — a guard that
    // reports on an unrelated helper is a guard someone deletes.
    for (const plugin of [REFERENCE_PLUGIN, ...COPY_PLUGINS]) {
      const index = readFileSync(resolve(PLUGINS_DIR, plugin, "index.ts"), "utf-8");
      expect(index, `${plugin}/index.ts must not test for a bare "401"`).not.toMatch(
        /includes\(\s*["'`]401/
      );
      expect(index, `${plugin}/index.ts must not declare a second auth classifier`).not.toMatch(
        /(function|const)\s+isAuthError\b/
      );
    }
  });

  it("a plugin that tracks mutations also reads the flag", () => {
    // `trackMutations` is a tripwire only while something acts on what it
    // sets, and nothing else covers that: deleting `if (mutated) throw err`
    // from pinchy-odoo/index.ts leaves all 493 of that plugin's tests green.
    // It has to, in fact — the gate fires only for a closure that performs a
    // step AFTER its mutating call, and no closure in the tree does, which is
    // exactly why the gate is here. So the wiring cannot be proved by running
    // it, and a textual check is the honest remaining option.
    //
    // Derived from the source, not from a list of plugins: the day a write
    // tool lands in pinchy-web, it is covered the moment it wraps a client.
    for (const plugin of [REFERENCE_PLUGIN, ...COPY_PLUGINS]) {
      const index = readFileSync(resolve(PLUGINS_DIR, plugin, "index.ts"), "utf-8");
      if (!/\btrackMutations\s*\(/.test(index)) continue;
      expect(
        index,
        `${plugin}/index.ts wraps a client in trackMutations but never gates the retry on it`
      ).toMatch(/if\s*\(\s*mutated\s*\)\s*(throw|return)\b/);
    }
  });
});
