import { describe, it, expect } from "vitest";
import { sanitizeFilename } from "@/lib/upload-validation";
// Cross-package relative import, same pattern as serve-workspace-file.test.ts:
// this is the drift guard between the plugin's generation-time filename
// validation and the serve route's sanitizeFilename. The two live in different
// packages and can't share code (plugins must not depend on the web package),
// so this test IS the contract: if either side's rules change incompatibly,
// it fails here instead of as dead download chips in production.
import { normalizeDeliverableBasename } from "../../../../plugins/pinchy-files/deliverable-filename";

describe("pinchy_generate_file filename ↔ serve-route sanitizer alignment (#788)", () => {
  // The serve route authorizes downloads by looking the grant up under
  // sanitizeFilename(urlFilename). The grant stores the name the tool emitted.
  // Invariant: every name the plugin ACCEPTS must be a fixed point of
  // sanitizeFilename — sanitize(name) === name — or the lookup never matches
  // and the chip 404s forever. (The plugin may reject MORE than the sanitizer
  // does; it must never accept a name the sanitizer would alter or reject.)
  it("every basename the plugin accepts round-trips sanitizeFilename unchanged once the extension and collision suffix are added", () => {
    const accepted = [
      "export",
      "  padded  ",
      "u\u0308bersicht", // NFD input — plugin normalizes to NFC, like the sanitizer
      "Q1 report",
      ".hidden",
      "kunden-liste_2026",
      "büro-käufe (Juli)",
    ];
    for (const raw of accepted) {
      const base = normalizeDeliverableBasename(raw);
      for (const name of [`${base}.csv`, `${base}-2.xlsx`, `${base}-99.pdf`]) {
        expect(sanitizeFilename(name), `for raw basename ${JSON.stringify(raw)}`).toBe(name);
      }
    }
  });

  it("rejects every basename class the sanitizer rejects (control chars, invisibles, quote/backtick, separators, traversal, empty, overlong)", () => {
    const rejected = [
      "ex\u0000port", // C0 control
      "ex\u200Bport", // zero-width space
      "ex\u202Eport", // BiDi override
      "ex\uFEFFport", // BOM/ZWNBSP
      'ex"port', // breaks Content-Disposition quoting
      "ex`port", // breaks the markdown code span in attachment blocks
      "a/b",
      "a\\b",
      "..",
      "a..b",
      "",
      "   ",
      ".",
      "x".repeat(300),
    ];
    for (const raw of rejected) {
      expect(
        () => normalizeDeliverableBasename(raw),
        `expected rejection for ${JSON.stringify(raw)}`
      ).toThrow();
    }
  });
});
