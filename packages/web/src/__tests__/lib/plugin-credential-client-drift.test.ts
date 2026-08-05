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
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const PLUGINS_DIR = resolve(import.meta.dirname, "../../../../plugins");
const REFERENCE_PLUGIN = "pinchy-odoo";

/** Every `pinchy-*` package, whether or not it carries a credential client. */
function allPlugins(): string[] {
  return readdirSync(PLUGINS_DIR)
    .filter((entry) => entry.startsWith("pinchy-"))
    .sort();
}

/**
 * The plugins carrying a copy, DISCOVERED rather than listed.
 *
 * A literal here would have been the same defect one level up: the guard
 * would report on the three copies it was told about, and the fourth plugin
 * to copy this module — the one whose author has not read this file — would
 * drift unwatched while the guard stayed green. That is the shape AGENTS.md
 * keeps naming, and it is the shape #1077 itself had.
 */
const COPY_OWNERS = allPlugins().filter((plugin) =>
  existsSync(resolve(PLUGINS_DIR, plugin, "credential-client.ts"))
);
const COPY_PLUGINS = COPY_OWNERS.filter((plugin) => plugin !== REFERENCE_PLUGIN);

/** Plugins known to carry a copy today — a floor, not the iteration set. */
const KNOWN_COPY_OWNERS = ["pinchy-email", "pinchy-odoo", "pinchy-web"];

function readCopy(plugin: string): string {
  return readFileSync(resolve(PLUGINS_DIR, plugin, "credential-client.ts"), "utf-8");
}

describe("credential-client drift guard", () => {
  const reference = readCopy(REFERENCE_PLUGIN);

  it("discovers the reference copy and every other plugin carrying one", () => {
    // Asserts against the filesystem, not against a literal three lines up.
    // Discovery is what makes a new copy covered automatically; this is what
    // keeps discovery itself from silently finding nothing — a renamed
    // plugin directory or a moved file would otherwise shrink the set to
    // one, and a set of one passes every byte-comparison there is.
    expect(COPY_OWNERS).toEqual(expect.arrayContaining(KNOWN_COPY_OWNERS));
    expect(COPY_OWNERS).toContain(REFERENCE_PLUGIN);
    expect(COPY_PLUGINS.length).toBeGreaterThan(0);
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
    //
    // Scanned across EVERY plugin, not only the three carrying a copy: a
    // plugin that hand-rolls a matcher instead of importing the module is
    // this drift in its purest form, and a scan restricted to copy owners
    // would look straight past it. No other plugin classifies an auth error
    // today, so widening the scope costs nothing and closes the gap.
    for (const plugin of allPlugins()) {
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
    // tool lands in pinchy-web — or in a plugin that does not exist yet —
    // it is covered the moment it wraps a client.
    for (const plugin of allPlugins()) {
      const index = readFileSync(resolve(PLUGINS_DIR, plugin, "index.ts"), "utf-8");
      if (!/\btrackMutations\s*\(/.test(index)) continue;
      expect(
        index,
        `${plugin}/index.ts wraps a client in trackMutations but never gates the retry on it`
      ).toMatch(/if\s*\(\s*mutated\s*\)\s*(throw|return)\b/);
    }
  });
});
