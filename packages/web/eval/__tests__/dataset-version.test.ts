import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATASET_FINGERPRINT, DATASET_VERSION } from "../dataset-version";
import { buildExport, isPublished } from "../export-scorecard";
import { fingerprintPublished } from "../../src/lib/eval/fingerprint";

/**
 * Guards the dataset's release mechanics (#802): a change to what the dataset
 * SAYS cannot ship without bumping the version AND recording why — the
 * maintenance discipline BetterBench found nearly every benchmark lacks.
 *
 * Two halves, and the second is the load-bearing one. Version-vs-changelog
 * agreement alone polices nothing: both files are edited in the same breath,
 * so a commit touching only `data/*.jsonl` — the one that actually moves every
 * number we publish — would sail through. The fingerprint is what notices that
 * commit.
 */
const CHANGELOG = readFileSync(path.join(__dirname, "..", "data", "CHANGELOG.md"), "utf8");

/** Reading the whole dataset re-grades three scenarios from their trajectories. */
const exported = await buildExport();

/**
 * Every published number, and nothing else. The rest spread is deliberate: it
 * covers whatever the export grows next (pass^k `comparisons` arrived after this
 * guard was written) instead of a hand-kept field list that would silently stop
 * covering the newest one. `datasetVersion` is excluded to avoid a circular
 * digest, `generatedFrom` because a constant provenance string is not a number.
 *
 * `not-yet-run` scenarios (#803) are excluded from `scenarios` too: they carry
 * no numbers by construction — no data file exists, so there is nothing to
 * version. Registering one must therefore NOT move the digest; the day its
 * sweep lands and it starts publishing numbers, it enters this subset and the
 * digest goes red exactly as for any other new number. The "publishes no
 * numbers" assertions below are what make this exclusion safe rather than a
 * blind spot.
 *
 * The `robustness` block (#803 PR 3) follows the same absence rule from the
 * other side: `buildExport` omits the key entirely while no paraphrase-variant
 * rows exist, so today it contributes nothing here. The first sweep that lands
 * variant rows makes the key appear, the rest-spread above picks it up
 * automatically, and the digest goes red — robustness numbers are published
 * numbers, and that red is the intended MINOR-bump prompt.
 */
const { datasetVersion: _version, generatedFrom: _source, ...allPublished } = exported;
const published = {
  ...allPublished,
  scenarios: exported.scenarios.filter(isPublished),
};

/** The versions of every `## [x.y.z] - ...` heading, in the order written. */
function changelogVersions(text: string): string[] {
  // Strip fenced code blocks first: a changelog entry quoting a heading in an
  // example is prose, not a release.
  const prose = text.replace(/^```[\s\S]*?^```/gm, "");
  return [...prose.matchAll(/^##\s*\[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
}

/** Negative when `a` precedes `b`, positive when it follows it, 0 when equal. */
function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

describe("dataset version", () => {
  it("is valid semver", () => {
    expect(DATASET_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("matches the newest CHANGELOG entry", () => {
    expect(changelogVersions(CHANGELOG)[0]).toBe(DATASET_VERSION);
  });

  it("has no duplicate version headings", () => {
    const versions = changelogVersions(CHANGELOG);
    expect(new Set(versions).size).toBe(versions.length);
  });

  it("lists CHANGELOG entries newest first", () => {
    // The "newest entry" assertion above reads entry [0]; appending a release
    // at the bottom would otherwise compare against an ancient version and
    // fail for a baffling reason.
    const versions = changelogVersions(CHANGELOG);
    const descending = versions.every((v, i) => i === 0 || compareSemver(versions[i - 1], v) > 0);
    expect(descending).toBe(true);
  });
});

describe("dataset fingerprint", () => {
  it("matches the published numbers", () => {
    // RED means the numbers we publish moved. That is not a reason to paste the
    // new digest in: decide what moved (a re-grade? a re-run? a new model? a
    // change to the comparison statistics?), bump DATASET_VERSION per the rule
    // in data/CHANGELOG.md, record the change there, and THEN update this
    // constant in the same commit.
    expect(fingerprintPublished(published)).toBe(DATASET_FINGERPRINT);
  });

  it("covers every scenario and cell the export publishes", () => {
    // Cheap sanity net: a fingerprint over an accidentally-empty read would be
    // a stable digest of nothing, and would keep passing forever. The export
    // carries 7 published + 4 not-yet-run scenarios (#803); the fingerprinted
    // subset is the published 7 — this extends the guard to the split without
    // weakening it, since every scenario with numbers is still counted below.
    expect(exported.scenarios).toHaveLength(11);
    expect(published.scenarios).toHaveLength(7);
    expect(published.scenarios.every((s) => s.models.length > 0)).toBe(true);
    expect(exported.comparisons.length).toBeGreaterThan(0);
  });

  it("keeps not-yet-run scenarios number-free, so excluding them hides nothing", () => {
    // The digest exclusion above is only sound while these entries publish no
    // numbers at all. A not-yet-run scenario that somehow carried cells would
    // be an unhashed published number — exactly what the fingerprint forbids.
    const pending = exported.scenarios.filter((s) => !isPublished(s));
    expect(pending).toHaveLength(4);
    for (const s of pending) {
      expect(s.models, s.label).toEqual([]);
      expect(s.totalRuns, s.label).toBe(0);
    }
  });

  it("covers every published field, so a new one cannot ship unhashed", () => {
    // The guard's own blind spot, guarded: `comparisons` was added to the export
    // after the fingerprint landed. If the payload ever narrows to a hand-kept
    // subset, a future field would silently escape the digest.
    expect(Object.keys(published).sort()).toEqual(
      Object.keys(exported)
        .filter((k) => k !== "datasetVersion" && k !== "generatedFrom")
        .sort()
    );
  });
});

describe("published export", () => {
  it("stamps the dataset version onto the exported scorecard", () => {
    // "Cite the version, not latest" is only followable if the artifact people
    // actually quote from carries it. The /reliability hub renders a copy of
    // this export — without the stamp, whoever holds the JSON cannot tell which
    // dataset produced it.
    expect(exported).toMatchObject({ datasetVersion: DATASET_VERSION });
  });
});
