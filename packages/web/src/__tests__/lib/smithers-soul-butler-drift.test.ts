/**
 * Drift guard (issue #1087): the "Butler" personality prose is duplicated
 * verbatim in two places —
 *
 *   - `smithers-soul.ts::SMITHERS_SOUL_MD`, the fixed system prompt for the
 *     built-in Smithers onboarding assistant, and
 *   - `personality-presets.ts::PERSONALITY_PRESETS["the-butler"].soulMd`, the
 *     starting-point prompt offered when a user creates a new agent with the
 *     "Butler" preset.
 *
 * The duplication is intentional: SMITHERS_SOUL_MD carries Smithers-specific
 * sections (Platform Knowledge, onboarding behavior, a "# Smithers" title
 * and an "##"-level heading) that a generic user-created agent must not
 * inherit, while the preset is a standalone "#"-level snippet a user goes on
 * to edit. Single-sourcing would force one of those shapes onto the other.
 * So — same contract as `normalize-docx-table-html-drift.test.ts` — this
 * pins the shared "Personality" paragraph text to stay identical rather than
 * silently drifting apart the next time either file is edited.
 */
import { describe, it, expect } from "vitest";
import { SMITHERS_SOUL_MD } from "@/lib/smithers-soul";
import { PERSONALITY_PRESETS } from "@/lib/personality-presets";

function extractBetween(source: string, startMarker: string, endMarker: string | null): string {
  const start = source.indexOf(startMarker);
  if (start === -1) {
    throw new Error(`start marker ${JSON.stringify(startMarker)} not found`);
  }
  const from = start + startMarker.length;
  const end = endMarker ? source.indexOf(endMarker, from) : source.length;
  if (endMarker && end === -1) {
    throw new Error(`end marker ${JSON.stringify(endMarker)} not found`);
  }
  return source.slice(from, end).trim();
}

describe("Butler personality prose drift guard", () => {
  it("SMITHERS_SOUL_MD's Personality section matches the-butler preset's soulMd", () => {
    const smithersPersonality = extractBetween(
      SMITHERS_SOUL_MD,
      "## Personality\n\n",
      "\n\n## Platform Knowledge"
    );
    const butlerPersonality = extractBetween(
      PERSONALITY_PRESETS["the-butler"].soulMd,
      "# Personality\n\n",
      null
    );

    expect(butlerPersonality).toBe(smithersPersonality);
  });
});
