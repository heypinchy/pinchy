/**
 * Drift guard: `pinned-target.ts` is duplicated, byte-for-byte, into
 * pinchy-odoo and pinchy-email.
 *
 * It is the plugin half of the DNS-rebinding fix: Pinchy's credentials route
 * answers the addresses it checked for a connection's stored destination
 * (`checkedAddresses`), and the plugin connects to those instead of resolving
 * the name again. Each plugin directory is mounted into the OpenClaw container
 * standalone, so the module cannot be shared by import — the same reason, and
 * the same answer, as `plugin-credential-client-drift.test.ts`: duplicate the
 * source, guard the copies. To change the module, edit the pinchy-odoo copy
 * and copy it over.
 *
 * NOTE ON COVERAGE: the module's unit tests live once, in
 * `packages/plugins/pinchy-odoo/__tests__/pinned-target.test.ts`. They count
 * as coverage for every copy only for as long as THIS test passes.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const PLUGINS_DIR = resolve(import.meta.dirname, "../../../../plugins");
const REFERENCE_PLUGIN = "pinchy-odoo";

// Discovered, not listed: a plugin that copies the module later is watched the
// moment it does. The floor in the first test keeps a broken walk from passing
// on an empty corpus.
const PLUGINS_WITH_A_COPY = readdirSync(PLUGINS_DIR)
  .filter((entry) => entry.startsWith("pinchy-"))
  .filter((plugin) => existsSync(resolve(PLUGINS_DIR, plugin, "pinned-target.ts")))
  .sort();

const COPY_PLUGINS = PLUGINS_WITH_A_COPY.filter((plugin) => plugin !== REFERENCE_PLUGIN);

function readCopy(plugin: string): string {
  return readFileSync(resolve(PLUGINS_DIR, plugin, "pinned-target.ts"), "utf-8");
}

describe("pinned-target drift guard", () => {
  const reference = readCopy(REFERENCE_PLUGIN);

  it("finds every plugin that carries a copy, including ones added later", () => {
    expect(PLUGINS_WITH_A_COPY).toEqual(expect.arrayContaining(["pinchy-email", "pinchy-odoo"]));
    expect(COPY_PLUGINS.length).toBeGreaterThanOrEqual(1);
  });

  it("the reference copy exports the shared surface", () => {
    for (const symbol of [
      "export interface PinnedAddress",
      "export type PinnedTarget",
      "export function checkedTarget",
      "export function pinnedLookup",
    ]) {
      expect(reference).toContain(symbol);
    }
  });

  it.each(COPY_PLUGINS)("%s carries a byte-identical copy", (plugin) => {
    expect(readCopy(plugin)).toBe(reference);
  });

  it("every plugin with a copy reads the checked addresses from its credentials answer", () => {
    // A copy nobody calls pins nothing. The byte comparison above cannot see
    // that, and the plugin's own tests stay green when the read is deleted
    // only if they never asserted the pin — so check the wiring textually.
    for (const plugin of PLUGINS_WITH_A_COPY) {
      const index = readFileSync(resolve(PLUGINS_DIR, plugin, "index.ts"), "utf-8");
      expect(index, `${plugin}/index.ts never reads checkedAddresses`).toMatch(
        /\bcheckedTarget\s*\(/
      );
    }
  });
});
