/**
 * Drift guard: the chunk locator — the union AND its renderer — is duplicated
 * across
 *   packages/web/src/lib/knowledge/locator.ts   (writes it: ingest, retrieve, schema)
 *   packages/plugins/pinchy-knowledge/locator.ts (renders it: formatWithCitations)
 *
 * The duplication is intentional and unavoidable: a plugin is a separate
 * package that cannot import from the web app (the same bundle-isolation reason
 * `normalizeTableHtml` is duplicated), yet the plugin is the layer that turns a
 * locator into the citation string a reader sees.
 *
 * What drift would cost: Wave 2 adds a producer per format (Word headings,
 * slides, sheet ranges). A kind added on the web side only would reach the
 * plugin as an unhandled variant and render as nothing — a citation that names
 * a document but no longer says WHERE in it, which is half of what makes a
 * citation checkable. The whole point of keeping the locator a closed union
 * (#933) is that the two sides cannot diverge, so the closure has to be
 * enforced across the package boundary too, not just inside each copy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const WEB_FILE = resolve(import.meta.dirname, "../../../lib/knowledge/locator.ts");
const PLUGIN_FILE = resolve(
  import.meta.dirname,
  "../../../../../plugins/pinchy-knowledge/locator.ts"
);

/** Strips comments and collapses whitespace: prose may differ, code may not. */
function canonicalize(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/.*$/gm, "")
    .replace(/\s+/g, " ")
    .trim();
}

describe("ChunkLocator drift guard", () => {
  it("web and plugin copies are identical modulo comments and whitespace", () => {
    const web = canonicalize(readFileSync(WEB_FILE, "utf-8"));
    const plugin = canonicalize(readFileSync(PLUGIN_FILE, "utf-8"));

    expect(plugin).toBe(web);
  });

  it("both copies declare every locator kind, so neither can quietly lose one", () => {
    // Belt and braces on top of the equality check: if a future edit ever
    // relaxes the comparison, this still fails when a kind goes missing.
    for (const [label, file] of [
      ["web", WEB_FILE],
      ["plugin", PLUGIN_FILE],
    ] as const) {
      const source = readFileSync(file, "utf-8");
      for (const kind of ["page", "slide", "heading", "sheet"]) {
        expect(source, `${label} copy is missing the "${kind}" locator kind`).toContain(
          `kind: "${kind}"`
        );
      }
    }
  });
});
