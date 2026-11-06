/**
 * Where the release path learns which release came before this one.
 *
 * `scripts/release.mjs` used to answer that with
 * `git describe --tags --abbrev=0` — the newest tag REACHABLE FROM HEAD. That
 * was correct while every release was cut from `main`, and it stopped being
 * correct the moment releases moved to `release/X.Y` branches: v0.9.0 and
 * v0.9.1 were cut from `release/0.9`, which never merged back, so `main`
 * answers **v0.8.0**. The upgrade-notes gate then looks for a
 * `## Upgrading from v0.8.0 to …` section, finds the frozen one, and aborts —
 * and had it not aborted, `finalizeUpgradeSection` would have frozen a section
 * nobody wrote for this release.
 *
 * AGENTS.md already settled the question for `version-identity.mjs`: the
 * offline source of truth for "newest released version" is `upgrading.mdx`'s
 * newest frozen section, because it is in the repo, needs no tags fetched, and
 * a release has to update it anyway. `newestFrozenRelease` is that one reading.
 * This module keeps the release path on it.
 */

/** Files that must derive the previous release version from upgrading.mdx. */
export const PREV_VERSION_CONSUMERS = [
  "scripts/release.mjs",
  "scripts/release-preflight.mjs",
];

/**
 * Blank out JS comments, length-preserving, leaving string literals alone.
 *
 * String literals are deliberately kept: the thing being detected IS one
 * (`exec("git describe --tags --abbrev=0")`), so a stripper that also blanked
 * strings would find nothing and read exactly like a clean pass. Comments must
 * go for the mirror reason — this module's own prose names the banned call, and
 * so will the comment somebody leaves where the call used to be.
 */
export function stripJsComments(source) {
  let out = "";
  let i = 0;
  let mode = "code"; // code | line | block | single | double | template
  while (i < source.length) {
    const c = source[i];
    const next = source[i + 1];
    if (mode === "code") {
      if (c === "/" && next === "/") {
        mode = "line";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "/" && next === "*") {
        mode = "block";
        out += "  ";
        i += 2;
        continue;
      }
      if (c === "'") mode = "single";
      else if (c === '"') mode = "double";
      else if (c === "`") mode = "template";
      out += c;
      i += 1;
      continue;
    }
    if (mode === "line") {
      if (c === "\n") {
        mode = "code";
        out += c;
      } else {
        out += " ";
      }
      i += 1;
      continue;
    }
    if (mode === "block") {
      if (c === "*" && next === "/") {
        mode = "code";
        out += "  ";
        i += 2;
        continue;
      }
      out += c === "\n" ? c : " ";
      i += 1;
      continue;
    }
    // inside a string literal: copy verbatim, honouring escapes
    if (c === "\\") {
      out += source.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (
      (mode === "single" && c === "'") ||
      (mode === "double" && c === '"') ||
      (mode === "template" && c === "`")
    ) {
      mode = "code";
    }
    out += c;
    i += 1;
  }
  return out;
}

/**
 * Lines that derive a version from the newest tag reachable from HEAD.
 *
 * Narrow on purpose: `git tag --list` and `git rev-parse` are fine and are used
 * elsewhere in these scripts for other questions. It is `git describe`'s
 * reachability semantics that the release-branch model breaks.
 */
export function findReachableTagDerivations(source) {
  const code = stripJsComments(source);
  const hits = [];
  code.split("\n").forEach((line, idx) => {
    if (/git\s+describe\b[^\n]*--tags/.test(line)) {
      hits.push({ line: idx + 1, text: line.trim() });
    }
  });
  return hits;
}

/** Does this file actually read upgrading.mdx's newest frozen section? */
export function readsFrozenSectionReader(source) {
  return /\bnewestFrozenRelease\b/.test(stripJsComments(source));
}

/**
 * Both directions: no reachability-based derivation, and the frozen-section
 * reader really is used. Checking only the first would pass a file that
 * derives nothing at all.
 */
export function checkPrevVersionSource(source, file) {
  const problems = [];
  for (const hit of findReachableTagDerivations(source)) {
    problems.push(
      `${file}:${hit.line} derives a version from the newest REACHABLE tag: ${hit.text}\n` +
        `  A release cut from release/X.Y is not reachable from main, so this answers the\n` +
        `  wrong release there. Read upgrading.mdx's newest frozen section instead:\n` +
        `  import { newestFrozenRelease } from "./lib/version-identity.mjs".`,
    );
  }
  if (!readsFrozenSectionReader(source)) {
    problems.push(
      `${file} does not read upgrading.mdx's newest frozen section ` +
        `(newestFrozenRelease). That is the release path's source of truth for ` +
        `which release came before this one.`,
    );
  }
  return problems;
}
