/**
 * Drift guard: which extensions a citation can be turned into a link for is
 * decided TWICE inside source-links.ts, and the two must agree.
 *
 * `EXTENSION` is the landmark the windowed scan hunts for — the reason the
 * transform is linear rather than catastrophically backtracking — and
 * `SOURCE_PATH_ENDING_HERE` is the anchored pattern that validates the path
 * ending there. They exist as a pair only because the scan cannot be driven by
 * the anchored pattern itself, not because they are allowed to differ.
 *
 * Both directions are a real defect and neither shows up as a test failure
 * elsewhere:
 *
 *   - an extension in `EXTENSION` but not in the path pattern is dead work —
 *     every occurrence is found and then rejected, and it reads as "we support
 *     .docx" while linking nothing;
 *   - an extension in the path pattern but not in `EXTENSION` is worse: the
 *     scan never looks there, so the type is silently unlinkable and the only
 *     symptom is a citation that stopped being clickable.
 *
 * Wave 2 widens this alternation (#936/#937 make Office and spreadsheets
 * servable), which is exactly when a pair like this drifts. Source inspection
 * rather than behaviour, because the failure is a MISSING case: no fixture set
 * can cover an extension nobody has thought of yet.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { DEFAULT_ALLOWED_EXTENSIONS } from "@/lib/knowledge/exclude-globs";

const SOURCE_LINKS = resolve(import.meta.dirname, "../../../lib/knowledge/source-links.ts");

/** Every `.ext` literal inside a regex assigned to `name`. */
function extensionsIn(source: string, name: string): string[] {
  const declaration = new RegExp(`const ${name}\\s*=\\s*(/[^\\n]+/[gimsuy]*)`).exec(source);
  if (!declaration) {
    throw new Error(`No regex literal assigned to ${name} in source-links.ts — update this guard`);
  }
  return [...declaration[1].matchAll(/\\\.([a-z0-9]+)/gi)].map((m) => m[1].toLowerCase()).sort();
}

describe("linkable-extension drift guard", () => {
  const source = readFileSync(SOURCE_LINKS, "utf-8");

  it("the scan landmark and the path pattern allow exactly the same extensions", () => {
    expect(extensionsIn(source, "EXTENSION")).toEqual(
      extensionsIn(source, "SOURCE_PATH_ENDING_HERE")
    );
  });

  it("links no type the ingest cannot index in the first place", () => {
    // The looser direction is fine and stays unasserted: the ingest may accept
    // a type before the viewer can render it (Wave 2 lands in that order). The
    // reverse is a broken promise — a link the route can only 404, offered for
    // a document that was never in the corpus.
    const indexable = DEFAULT_ALLOWED_EXTENSIONS.map((ext) => ext.replace(/^\./, "").toLowerCase());
    for (const linkable of extensionsIn(source, "EXTENSION")) {
      expect(indexable, `.${linkable} is linkable but not indexable`).toContain(linkable);
    }
  });
});
