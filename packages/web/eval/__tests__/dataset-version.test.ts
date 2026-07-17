import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DATASET_VERSION } from "../dataset-version";

/**
 * Guards the dataset's release mechanics (#802): the version constant must be
 * valid semver and must match the newest entry in the dataset CHANGELOG, so a
 * re-grade or a re-run can't ship without bumping the version AND recording why
 * — the maintenance discipline BetterBench found nearly every benchmark lacks.
 */
const CHANGELOG = readFileSync(path.join(__dirname, "..", "data", "CHANGELOG.md"), "utf8");

/** The versions of every `## [x.y.z] - ...` heading, newest first as written. */
function changelogVersions(text: string): string[] {
  return [...text.matchAll(/^##\s*\[(\d+\.\d+\.\d+)\]/gm)].map((m) => m[1]);
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
});
