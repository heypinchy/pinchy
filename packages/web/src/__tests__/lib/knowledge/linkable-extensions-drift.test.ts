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

/**
 * Every extension a regex assigned to `name` accepts.
 *
 * Reads the alternation, not a list of `\.ext` literals. That distinction cost
 * this guard its whole value once already: it was written when the patterns
 * spelled the set as `\.pdf|\.docx`, the Office commit (#939) rewrote both as
 * `\.(?:pdf|docx?|pptx?)` — a single `\.` in front of a group — and from then
 * on BOTH calls returned `[]`. Test one compared `[]` to `[]`, test two looped
 * over nothing, and the pair stayed green while checking neither direction.
 *
 * Hence the two floors below. A guard that reads nothing must fail, not pass:
 * the failure this exists for is a MISSING case, and an extractor that finds
 * no cases at all cannot see a missing one. Same rule as
 * `extractAuditEventTypes` one level up — throw on input you cannot read
 * rather than return a short list.
 */
function extensionsIn(source: string, name: string): string[] {
  const declaration = new RegExp(`const ${name}\\s*=\\s*(/[^\\n]+/[gimsuy]*)`).exec(source);
  if (!declaration) {
    throw new Error(`No regex literal assigned to ${name} in source-links.ts — update this guard`);
  }

  const alternation = /\\\.\(\?:([a-z0-9|?]+)\)/i.exec(declaration[1]);
  if (!alternation) {
    throw new Error(
      `Could not read an extension alternation out of ${name} (${declaration[1]}) — the pattern ` +
        `changed shape and this guard no longer reads it. Do not leave it returning nothing.`
    );
  }

  // `docx?` is two extensions, and expanding it is the point: the optional
  // suffix is how both patterns spell "doc and docx", so a guard that reported
  // one literal `docx?` could not tell `.doc` from `.docx` on either side.
  const extensions = alternation[1]
    .split("|")
    .flatMap((alt) => (alt.endsWith("?") ? [alt.slice(0, -2), alt.slice(0, -1)] : [alt]));
  if (extensions.length === 0) {
    throw new Error(`Read no extensions out of ${name} — see the floor above.`);
  }
  return extensions.map((ext) => ext.toLowerCase()).sort();
}

describe("linkable-extension drift guard", () => {
  const source = readFileSync(SOURCE_LINKS, "utf-8");

  it("the scan landmark and the path pattern allow exactly the same extensions", () => {
    expect(extensionsIn(source, "EXTENSION")).toEqual(
      extensionsIn(source, "SOURCE_PATH_ENDING_HERE")
    );
  });

  /**
   * Linkable, deliberately, before the ingest can index it — each with the
   * issue that closes the gap.
   *
   * The Office formats became linkable with their preview route (#939) and
   * become indexable with the ingest integration (#938), which is the order
   * those issues plan. Until #938 lands, a path-shaped `.doc` mentioned in
   * chat prose really does linkify to a route that answers 404: nothing has
   * converted the document, so `resolveConvertedArtifact` finds no artifact.
   * That is a real if narrow cost, and naming it here is what keeps it a
   * decision rather than an oversight.
   */
  const PENDING_INGEST: Record<string, string> = {
    doc: "#938 — Office ingest; linkable since the preview route (#939)",
    docx: "#938 — Office ingest; linkable since the preview route (#939)",
    ppt: "#938 — Office ingest; linkable since the preview route (#939)",
    pptx: "#938 — Office ingest; linkable since the preview route (#939)",
  };

  it("links no type the ingest cannot index in the first place", () => {
    // The looser direction is fine and stays unasserted: the ingest may accept
    // a type before the viewer can render it (a spreadsheet is indexed and not
    // linkable, #940). The reverse is a broken promise — a link the route can
    // only 404 — so it is allowed only with an issue against its name.
    const indexable = DEFAULT_ALLOWED_EXTENSIONS.map((ext) => ext.replace(/^\./, "").toLowerCase());
    for (const linkable of extensionsIn(source, "EXTENSION")) {
      if (linkable in PENDING_INGEST) continue;
      expect(indexable, `.${linkable} is linkable but not indexable`).toContain(linkable);
    }
  });

  it("carries no pending-ingest entry for a type the ingest already takes", () => {
    // A stale exemption is the same drift one level up: it would go on
    // excusing a gap that closed, and the day a fifth format is added nobody
    // would trust the list. #938 lands -> these entries must go.
    const indexable = DEFAULT_ALLOWED_EXTENSIONS.map((ext) => ext.replace(/^\./, "").toLowerCase());
    for (const [ext, reason] of Object.entries(PENDING_INGEST)) {
      expect(indexable, `.${ext} is indexable now — drop its entry (${reason})`).not.toContain(ext);
    }
  });
});
