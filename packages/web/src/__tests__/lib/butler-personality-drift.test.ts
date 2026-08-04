/**
 * Drift-guard: the butler personality prose is duplicated across
 * `lib/smithers-soul.ts` (SMITHERS_SOUL_MD's `## Personality` section) and
 * `lib/personality-presets.ts` (`the-butler`.soulMd).
 *
 * They are the same voice by design, not by accident: `createSmithersAgent`
 * stamps `personalityPresetId: "the-butler"` onto Smithers itself, so an
 * instance whose preset says one thing and whose SOUL.md says another is
 * describing one agent two ways.
 *
 * The duplication is kept rather than single-sourced, and the reason is the
 * hash contract next door. `CURRENT_SOUL_HASH` is derived from the evaluated
 * SMITHERS_SOUL_MD, and `SHIPPED_SOUL_HASHES` is append-only: sharing one
 * constant would make an ordinary preset-copy tweak silently change Smithers'
 * soul hash, forcing a new history entry and re-running the boot migration
 * across every existing install. A cosmetic edit must not carry that blast
 * radius — so the two texts stay separate and this test is what keeps them
 * honest (#1087).
 *
 * Deliberately diverging the two is allowed; it just has to be a decision.
 * Change the expectation here and say why, the same way a released upgrade
 * note or a test deletion has to be authorized rather than merely done.
 *
 * Note what this does NOT relax: `smithers-soul-history.test.ts` still forbids
 * a preset from hashing into SHIPPED_SOUL_HASHES. That guard is about the
 * WHOLE soul colliding; this one is about the shared paragraph drifting. Both
 * hold at once — the butler preset carries only this prose, while Smithers
 * wraps it in a `# Smithers` header and a `## Platform Knowledge` section, so
 * the two full strings can never be equal.
 */
import { describe, it, expect } from "vitest";

import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";
import { PERSONALITY_PRESETS } from "@/lib/personality-presets";

/**
 * Slice out the text between two markers. Throws rather than returning "" when
 * a marker is missing: an extractor that quietly returns nothing would compare
 * empty against empty and pass, which is the failure mode this guard exists to
 * prevent.
 */
function sliceBetween(source: string, start: string, end: string | null, label: string): string {
  const from = source.indexOf(start);
  if (from === -1) {
    throw new Error(`${label}: start marker ${JSON.stringify(start)} not found`);
  }
  const bodyStart = from + start.length;
  if (end === null) return source.slice(bodyStart).trim();

  const to = source.indexOf(end, bodyStart);
  if (to === -1) {
    throw new Error(`${label}: end marker ${JSON.stringify(end)} not found`);
  }
  return source.slice(bodyStart, to).trim();
}

describe("butler personality prose drift guard", () => {
  it("Smithers' SOUL and the-butler preset carry identical personality prose", () => {
    const fromSoul = sliceBetween(
      SMITHERS_SOUL_MD,
      "## Personality\n",
      "\n## Platform Knowledge",
      "SMITHERS_SOUL_MD"
    );
    const fromPreset = sliceBetween(
      PERSONALITY_PRESETS["the-butler"].soulMd,
      "# Personality\n",
      null,
      "the-butler.soulMd"
    );

    expect(fromPreset).toBe(fromSoul);
  });

  it("extracts a substantial block from both, not an empty string", () => {
    // A corpus floor, for the same reason the docs-coverage checks carry one:
    // a comparison of two empty strings passes while proving nothing.
    const fromSoul = sliceBetween(
      SMITHERS_SOUL_MD,
      "## Personality\n",
      "\n## Platform Knowledge",
      "SMITHERS_SOUL_MD"
    );
    expect(fromSoul.length).toBeGreaterThan(500);
    expect(fromSoul).toContain("unfailingly polite");
  });

  it("the two full souls still differ, so the migration cannot overwrite a preset", () => {
    // The complement of the collision guard in smithers-soul-history.test.ts,
    // asserted here too because it is what makes "share the prose, not the
    // soul" safe.
    expect(PERSONALITY_PRESETS["the-butler"].soulMd).not.toBe(SMITHERS_SOUL_MD);
  });
});
