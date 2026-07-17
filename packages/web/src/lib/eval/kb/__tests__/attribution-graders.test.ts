import { describe, expect, it } from "vitest";

import {
  citedSourcePaths,
  composeKbGraderResults,
  gradeAttribution,
  gradeCitationResolution,
  gradeNoDuplicateCorroboration,
  gradePathCitation,
  gradeSourcesFormat,
} from "../attribution-graders";
import type { AttributionInput, RetrievedSource } from "../attribution-graders";
import type { KbGraderResult } from "../types";

function src(n: number, sourcePath: string, page: number | null = 1): RetrievedSource {
  return { n, sourcePath, page };
}

describe("gradeCitationResolution", () => {
  it("flags a cited number with no Sources entry (Block-E shape: [1][4] inline, Sources holds only [1],[2],[5],[8])", () => {
    // All of [1], [2], [5], [8] are cited inline elsewhere in the body (so
    // none of THOSE trip source-uncited) — the sole defect under test is the
    // extra "[4]" inline citation that has no matching Sources entry at all.
    const input: AttributionInput = {
      answer: `Fact one [1]. Fact two [4]. Fact three [2]. Fact four [5]. Fact five [8].

**Sources:**

- [1] /data/handbook/policy.md — p. 1
- [2] /data/handbook/policy.md — p. 2
- [5] /data/handbook/policy.md — p. 5
- [8] /data/handbook/policy.md — p. 8`,
      retrieved: [
        src(1, "/data/handbook/policy.md"),
        src(2, "/data/handbook/policy.md"),
        src(5, "/data/handbook/policy.md"),
        src(8, "/data/handbook/policy.md"),
      ],
    };

    const result = gradeCitationResolution(input);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["citation-unresolved"]);
    expect(result.notes[0]).toMatch(/\[4\]/);
  });

  it("flags a Sources entry never cited inline (Block-A shape: answer cites only [1], Sources also lists [2])", () => {
    const input: AttributionInput = {
      answer: `The quality manual requires annual review [1].

**Sources:**

- [1] /data/quality/Quality File 2012_4.pdf — p. 12
- [2] /data/quality/Quality File 2012_4.pdf — p. 169`,
      retrieved: [
        src(1, "/data/quality/Quality File 2012_4.pdf"),
        src(2, "/data/quality/Quality File 2012_4.pdf"),
      ],
    };

    const result = gradeCitationResolution(input);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["source-uncited"]);
    expect(result.notes[0]).toMatch(/\[2\]/);
  });

  it("passes a bidirectionally-matched single-source answer", () => {
    const input: AttributionInput = {
      answer: `The answer is X [1].

**Sources:**

- [1] /data/a.md — p. 1`,
      retrieved: [src(1, "/data/a.md")],
    };

    expect(gradeCitationResolution(input)).toEqual<KbGraderResult>({
      passed: true,
      tags: [],
      notes: [],
    });
  });

  it("does not double-count a repeated inline citation ([1][1]) as anything other than one resolved number", () => {
    const input: AttributionInput = {
      answer: `First claim [1]. Second claim also [1].

**Sources:**

- [1] /data/a.md — p. 1`,
      retrieved: [src(1, "/data/a.md")],
    };

    expect(gradeCitationResolution(input).passed).toBe(true);
  });

  it("resolves multi-digit citation numbers ([12])", () => {
    const input: AttributionInput = {
      answer: `A claim backed by a later source [12].

**Sources:**

- [12] /data/big-corpus/appendix.md — p. 40`,
      retrieved: [src(12, "/data/big-corpus/appendix.md")],
    };

    expect(gradeCitationResolution(input)).toEqual<KbGraderResult>({
      passed: true,
      tags: [],
      notes: [],
    });
  });

  it("flags both directions at once when both an unresolved citation and an uncited source are present", () => {
    const input: AttributionInput = {
      answer: `Claim one [1]. Claim two [3].

**Sources:**

- [1] /data/a.md — p. 1
- [2] /data/b.md — p. 2`,
      retrieved: [src(1, "/data/a.md"), src(2, "/data/b.md"), src(3, "/data/c.md")],
    };

    const result = gradeCitationResolution(input);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["citation-unresolved", "source-uncited"]);
  });
});

describe("gradePathCitation", () => {
  it("flags a bare filename instead of a full path", () => {
    const input: AttributionInput = {
      answer: `The manual requires review [1].

**Sources:**

- [1] Quality File 2012_4.pdf — p. 12`,
      retrieved: [src(1, "/data/quality/Quality File 2012_4.pdf")],
    };

    const result = gradePathCitation(input);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["path-not-cited"]);
    expect(result.notes[0]).toMatch(/bare filename/);
  });

  it("flags a path that does not match any retrieved source", () => {
    const input: AttributionInput = {
      answer: `The manual requires review [1].

**Sources:**

- [1] /data/other-folder/unrelated.md — p. 3`,
      retrieved: [src(1, "/data/quality/Quality File 2012_4.pdf")],
    };

    const result = gradePathCitation(input);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["path-not-cited"]);
    expect(result.notes[0]).toMatch(/does not match/);
  });

  it("passes when the Sources entry reproduces the exact full path knowledge_search returned", () => {
    const input: AttributionInput = {
      answer: `X [1].

**Sources:**

- [1] /data/handbook-2012/policy.md — p. 12`,
      retrieved: [src(1, "/data/handbook-2012/policy.md")],
    };

    expect(gradePathCitation(input)).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("does not choke on a hyphen inside the path itself when parsing the trailing page suffix", () => {
    // "/data/handbook-2012/policy.md" has a hyphen in the folder name; the
    // page-suffix parser must land on the LAST "— p. N" and not mistake the
    // "-2012" for the dash separator.
    const input: AttributionInput = {
      answer: `X [1].

**Sources:**

- [1] /data/handbook-2012/policy.md — p. 12`,
      retrieved: [src(1, "/data/handbook-2012/policy.md")],
    };

    expect(gradePathCitation(input).passed).toBe(true);
  });

  it("tolerates a Sources entry with a missing page suffix without false-flagging the path", () => {
    const input: AttributionInput = {
      answer: `X [1].

**Sources:**

- [1] /data/a.md`,
      retrieved: [src(1, "/data/a.md")],
    };

    expect(gradePathCitation(input)).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });
});

describe("gradeSourcesFormat", () => {
  it("flags a run-on (non-bullet) Sources list", () => {
    const input: AttributionInput = {
      answer: `Fact one [1]. Fact two [4].

**Sources:** [1] /data/quality/2012_4.pdf — p. 169 [4] /data/quality/2012_4.pdf — p. 194`,
      retrieved: [src(1, "/data/quality/2012_4.pdf"), src(4, "/data/quality/2012_4.pdf")],
    };

    const result = gradeSourcesFormat(input);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["sources-format"]);
  });

  it("still requires the bullet form when there is exactly one source", () => {
    const input: AttributionInput = {
      answer: `X [1].

**Sources:** [1] /data/a.md — p. 1`,
      retrieved: [src(1, "/data/a.md")],
    };

    const result = gradeSourcesFormat(input);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["sources-format"]);
  });

  it("passes a properly bulleted multi-source Sources list", () => {
    const input: AttributionInput = {
      answer: `X [1]. Y [2].

**Sources:**

- [1] /data/a.md — p. 1
- [2] /data/b.md — p. 2`,
      retrieved: [src(1, "/data/a.md"), src(2, "/data/b.md")],
    };

    expect(gradeSourcesFormat(input)).toEqual<KbGraderResult>({
      passed: true,
      tags: [],
      notes: [],
    });
  });

  it("passes an honest abstention answer with no Sources list at all", () => {
    const input: AttributionInput = {
      answer: "I couldn't find this in the knowledge base.",
      retrieved: [],
    };

    expect(gradeSourcesFormat(input)).toEqual<KbGraderResult>({
      passed: true,
      tags: [],
      notes: [],
    });
  });
});

describe("gradeNoDuplicateCorroboration", () => {
  it("flags near-duplicate co-citation when the Sources list cites 2+ paths from the same group", () => {
    const input: AttributionInput = {
      answer: `The policy requires annual review [1][2].

**Sources:**

- [1] /data/handbook-2012-en/policy.md — p. 4
- [2] /data/handbook-2012-de/policy.md — p. 4`,
      retrieved: [
        src(1, "/data/handbook-2012-en/policy.md"),
        src(2, "/data/handbook-2012-de/policy.md"),
      ],
      nearDuplicateGroups: [
        ["/data/handbook-2012-en/policy.md", "/data/handbook-2012-de/policy.md"],
      ],
    };

    const result = gradeNoDuplicateCorroboration(input);

    expect(result.passed).toBe(false);
    expect(result.tags).toEqual(["dedup-inflation"]);
  });

  it("passes when nearDuplicateGroups is empty/undefined", () => {
    const input: AttributionInput = {
      answer: `X [1][2].

**Sources:**

- [1] /data/a.md — p. 1
- [2] /data/b.md — p. 2`,
      retrieved: [src(1, "/data/a.md"), src(2, "/data/b.md")],
    };

    expect(gradeNoDuplicateCorroboration(input)).toEqual<KbGraderResult>({
      passed: true,
      tags: [],
      notes: [],
    });
  });

  it("passes when only ONE member of a near-duplicate group is cited", () => {
    const input: AttributionInput = {
      answer: `X [1].

**Sources:**

- [1] /data/handbook-2012-en/policy.md — p. 4`,
      retrieved: [src(1, "/data/handbook-2012-en/policy.md")],
      nearDuplicateGroups: [
        ["/data/handbook-2012-en/policy.md", "/data/handbook-2012-de/policy.md"],
      ],
    };

    expect(gradeNoDuplicateCorroboration(input).passed).toBe(true);
  });
});

describe("composeKbGraderResults", () => {
  it("passes only when every result passes, dedups tags preserving first-seen order, and concats notes", () => {
    const results: KbGraderResult[] = [
      { passed: true, tags: [], notes: ["note-a"] },
      { passed: false, tags: ["path-not-cited"], notes: ["note-b"] },
      {
        passed: false,
        tags: ["citation-unresolved", "path-not-cited"],
        notes: ["note-c", "note-d"],
      },
    ];

    expect(composeKbGraderResults(results)).toEqual<KbGraderResult>({
      passed: false,
      tags: ["path-not-cited", "citation-unresolved"],
      notes: ["note-a", "note-b", "note-c", "note-d"],
    });
  });

  it("passes with empty tags/notes when all inputs pass", () => {
    expect(
      composeKbGraderResults([
        { passed: true, tags: [], notes: [] },
        { passed: true, tags: [], notes: [] },
      ])
    ).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("de-duplicates byte-identical notes so a grader reused twice (gradePathCitation via both gradeAttribution and gradeCitationCorrectness) emits its note once", () => {
    // gradeKbRun runs gradePathCitation twice against the SAME retrieved set
    // (once inside gradeAttribution, once as gradeCitationCorrectness), so on a
    // real fabricated citation both emit the identical note. The tag is already
    // Set-deduped; this keeps the human-readable notes array from carrying the
    // same line twice.
    const results: KbGraderResult[] = [
      { passed: false, tags: ["path-not-cited"], notes: ["same note", "unique-1"] },
      { passed: false, tags: ["path-not-cited"], notes: ["same note"] },
    ];

    expect(composeKbGraderResults(results)).toEqual<KbGraderResult>({
      passed: false,
      tags: ["path-not-cited"],
      notes: ["same note", "unique-1"],
    });
  });
});

describe("gradeAttribution", () => {
  it("passes a well-formed, bidirectionally-matched, full-path, bulleted, single-source answer", () => {
    const input: AttributionInput = {
      answer: `The retention policy requires records be kept for seven years [1].

**Sources:**

- [1] /data/handbook-2012/records-policy.md — p. 12`,
      retrieved: [src(1, "/data/handbook-2012/records-policy.md")],
    };

    expect(gradeAttribution(input)).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("passes an honest abstention answer with no Sources list", () => {
    const input: AttributionInput = {
      answer: "I couldn't find this in the knowledge base.",
      retrieved: [],
    };

    expect(gradeAttribution(input)).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("composes multiple simultaneous defects (Block-A + bare filename) into one failing verdict", () => {
    const input: AttributionInput = {
      answer: `The manual requires annual review [1].

**Sources:**

- [1] Quality File 2012_4.pdf — p. 12
- [2] Quality File 2012_4.pdf — p. 169`,
      retrieved: [
        src(1, "/data/quality/Quality File 2012_4.pdf"),
        src(2, "/data/quality/Quality File 2012_4.pdf"),
      ],
    };

    const result = gradeAttribution(input);

    expect(result.passed).toBe(false);
    // [1] and [2] both cite bare filenames (path-not-cited), and [2] is
    // never cited inline (source-uncited) — both fire from one answer.
    expect(result.tags).toContain("path-not-cited");
    expect(result.tags).toContain("source-uncited");
  });

  it("does not mis-split on a capitalized 'Sources:' appearing mid-prose before the real trailing list", () => {
    // Regression: the answer body legitimately contains the word "Sources:"
    // mid-sentence, and the REAL Sources heading is the trailing markdown
    // block. A first-match split would truncate the body at "Based on my "
    // and swallow the real inline [1] into the Sources region, emitting FALSE
    // source-uncited + sources-format failures on a well-formed answer. The
    // heading must be located by its TRAILING line-anchored form, not the
    // first substring hit.
    const input: AttributionInput = {
      answer: `Based on my Sources: the policy requires annual review [1].

**Sources:**

- [1] /data/a.md — p. 1`,
      retrieved: [src(1, "/data/a.md")],
    };

    expect(gradeAttribution(input)).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("does not treat a genuinely mid-line 'Sources:' (prose continues on the same line) as the heading", () => {
    // A "Sources:" with more text after it on the SAME line is prose, not a
    // heading. With no real trailing heading, this answer has no Sources list
    // at all — an honest inline-only answer must not manufacture a phantom
    // Sources region (which would then false-flag sources-format on prose).
    const input: AttributionInput = {
      answer: "See Sources: the internal wiki and the handbook for details [1].",
      retrieved: [src(1, "/data/a.md")],
    };

    const result = gradeAttribution(input);

    // No trailing heading ⟹ no Sources list ⟹ sources-format has nothing to
    // check. The only real signal here is the inline [1] with no list entry.
    expect(result.tags).not.toContain("sources-format");
  });
});

describe("Sources heading shape robustness", () => {
  // Each variant is a plausible way a real Layer-3 model formats the heading.
  // If a variant is not recognized, hasSourcesList goes false, entries is
  // empty, and every inline [N] becomes a spurious citation-unresolved — a
  // scorecard-corrupting false positive. Each test asserts the trailing list
  // parses (a well-formed answer PASSES with no tags).
  const wellFormed = (heading: string): AttributionInput => ({
    answer: `The retention policy requires seven years [1].

${heading}

- [1] /data/handbook-2012/records-policy.md — p. 12`,
    retrieved: [src(1, "/data/handbook-2012/records-policy.md")],
  });

  it("recognizes `**Sources:**` (colon inside the bold)", () => {
    expect(gradeAttribution(wellFormed("**Sources:**"))).toEqual<KbGraderResult>({
      passed: true,
      tags: [],
      notes: [],
    });
  });

  it("recognizes `**Sources**:` (colon OUTSIDE the bold — a plausible model formatting)", () => {
    // Verified false negative before the widening: the colon-inside-only regex
    // did not match "**Sources**:", so the whole answer was treated as body,
    // entries was empty, and inline [1] fired a spurious citation-unresolved.
    expect(gradeAttribution(wellFormed("**Sources**:"))).toEqual<KbGraderResult>({
      passed: true,
      tags: [],
      notes: [],
    });
  });

  it("recognizes a plain `Sources:` heading (no bold)", () => {
    expect(gradeAttribution(wellFormed("Sources:"))).toEqual<KbGraderResult>({
      passed: true,
      tags: [],
      notes: [],
    });
  });

  it("recognizes a `### Sources:` hash heading", () => {
    expect(gradeAttribution(wellFormed("### Sources:"))).toEqual<KbGraderResult>({
      passed: true,
      tags: [],
      notes: [],
    });
  });

  it("still does NOT treat a mid-prose `Sources:` as a heading after the widening", () => {
    const input: AttributionInput = {
      answer: "See Sources: the internal wiki and the handbook for details [1].",
      retrieved: [src(1, "/data/a.md")],
    };
    expect(gradeAttribution(input).tags).not.toContain("sources-format");
  });
});

describe("gradePathCitation page-suffix robustness", () => {
  it("cleanly separates the path from a page-RANGE suffix (— p. 12-14)", () => {
    // A page range left pageMatch null in the single-page regex, folding
    // "— p. 12-14" into entry.path, which then spuriously failed the exact
    // path-match. The path must be extracted cleanly.
    const input: AttributionInput = {
      answer: `X [1].

**Sources:**

- [1] /data/a.md — p. 12-14`,
      retrieved: [src(1, "/data/a.md")],
    };

    expect(gradePathCitation(input)).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });

  it("cleanly separates the path from a `pp.` page-range suffix (— pp. 12-14)", () => {
    const input: AttributionInput = {
      answer: `X [1].

**Sources:**

- [1] /data/a.md — pp. 12-14`,
      retrieved: [src(1, "/data/a.md")],
    };

    expect(gradePathCitation(input)).toEqual<KbGraderResult>({ passed: true, tags: [], notes: [] });
  });
});

describe("citedSourcePaths", () => {
  it("returns the deduplicated, resolved (inline-cited AND listed) source paths, in Sources-list order", () => {
    const answer = `Fact one [1]. Fact two [2]. Fact one again [1].

**Sources:**

- [1] /data/a.md — p. 1
- [2] /data/b.md — p. 2`;

    expect(citedSourcePaths(answer)).toEqual(["/data/a.md", "/data/b.md"]);
  });

  it("excludes a Sources entry that was never cited inline (source-uncited)", () => {
    const answer = `Fact one [1].

**Sources:**

- [1] /data/a.md — p. 1
- [2] /data/b.md — p. 2`;

    expect(citedSourcePaths(answer)).toEqual(["/data/a.md"]);
  });

  it("excludes an inline citation with no matching Sources entry (citation-unresolved)", () => {
    const answer = `Fact one [1]. Fact two [4].

**Sources:**

- [1] /data/a.md — p. 1`;

    expect(citedSourcePaths(answer)).toEqual(["/data/a.md"]);
  });

  it("returns an empty array for an answer with no Sources list (e.g. an abstention)", () => {
    expect(citedSourcePaths("I couldn't find this in the knowledge base.")).toEqual([]);
  });
});
