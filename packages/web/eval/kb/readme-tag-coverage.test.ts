/**
 * `data/README.md`'s tag table must name every tag this sweep can hand down.
 *
 * It is a hand-maintained list that mirrors code, which AGENTS.md says will be
 * wrong — and it already was on the day it was written: it listed six of the
 * nine tags `gradeKbRun` composes, so `path-not-cited` and `false-abstention`
 * were reachable with nothing in the published dataset's own documentation to
 * look them up against. Nothing was red, because nothing was looking.
 *
 * (The third missing tag, `dedup-inflation`, turned out not to be reachable at
 * all — `gradeKbRun` passed `gradeAttribution` no `nearDuplicateGroups`, so the
 * grader passed unconditionally. #1179 wired the corpus's pairs through and
 * fixed the path comparison underneath, and the tag now charges 4 runs. The
 * reachability itself is guarded by behavioural tests next to `gradeKbRun` and
 * the grader; this file only checks that a tag is named.)
 *
 * Same shape as `scripts/lib/docs-coverage.test.mjs` one level up: read the
 * union from the source, and fail rather than shrink when the source stops
 * being readable.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { readAllRows } from "./export-kb-scorecard";

const TYPES_SRC = path.join(__dirname, "../../src/lib/eval/kb/types.ts");
const README = path.join(__dirname, "data/README.md");

/**
 * Tags the Layer-3 table deliberately does NOT carry, each with the reason.
 * An exemption is itself checked below: one naming a tag the union no longer
 * declares is the same drift one level up.
 */
const NOT_LAYER_3: Record<string, string> = {
  "recall-miss": "Layer 1 (retrieval), never emitted by gradeKbRun",
  "run-infra-error":
    "not a model-quality signal; the README covers it as an exclusion from n, not as an axis",
};

/**
 * The `KbFailureTag` union members, read from the source.
 *
 * Throws on a union it cannot parse rather than returning a short list: a
 * corpus floor only catches an extractor that finds NOTHING, and the failure
 * this guard exists for is one that finds most things.
 */
function extractFailureTags(source: string): string[] {
  const union = /export type KbFailureTag =([\s\S]*?);\n/.exec(source);
  if (!union) throw new Error(`Could not find the KbFailureTag union in ${TYPES_SRC}.`);

  const tags = [...union[1].matchAll(/\|\s*"([^"]+)"/g)].map((m) => m[1]);
  // Every `| "…"` alternative must have come back. A member spelled some other
  // way is an unread member, not a member that isn't there.
  const alternatives = union[1].split("|").filter((part) => part.trim().length > 0);
  if (tags.length !== alternatives.length) {
    throw new Error(
      `Read ${tags.length} of ${alternatives.length} KbFailureTag alternatives — the union's ` +
        `shape changed and this extractor no longer reads all of it.`
    );
  }
  return tags;
}

describe("data/README.md documents the tags the sweep can produce", () => {
  const tags = extractFailureTags(readFileSync(TYPES_SRC, "utf8"));
  const readme = readFileSync(README, "utf8");

  it("reads the whole KbFailureTag union", () => {
    expect(tags.length).toBeGreaterThan(5);
    expect(tags).toContain("ungrounded-claim");
  });

  it.each(tags.filter((tag) => !(tag in NOT_LAYER_3)))("documents `%s` in the tag table", (tag) => {
    expect(readme).toContain(`\`${tag}\``);
  });

  it("carries no exemption for a tag the union no longer declares", () => {
    for (const exempt of Object.keys(NOT_LAYER_3)) {
      expect(tags, `${exempt} is exempted here but is not a KbFailureTag`).toContain(exempt);
    }
  });

  it("documents every tag the published dataset actually charged", async () => {
    const charged = new Set((await readAllRows()).flatMap((r) => r.tags));

    // Corpus floor: an empty set makes the loop below zero assertions, which
    // is how a coverage guard becomes decoration.
    expect(charged.size).toBeGreaterThan(0);
    for (const tag of charged) expect(readme).toContain(`\`${tag}\``);
  });
});
