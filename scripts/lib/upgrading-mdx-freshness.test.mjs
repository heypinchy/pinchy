import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoStaleUpgradeSections } from "./release-logic.mjs";

// CI guard: the real docs/src/content/docs/guides/upgrading.mdx must not carry a
// stale `%%PINCHY_VERSION%%` left over from a release that forgot to freeze its
// section (the v0.5.8 miss).
//
// This used to read "root package.json#version always equals the most recently
// released tag, because `pnpm release` bumps it in the release commit". Since
// #1044 it does not: package.json declares `<next>-dev` at every moment that is
// not a release commit, so it names a release that has NOT shipped. It is still
// the input here, but `assertNoStaleUpgradeSections` now discards a `-dev`
// version and lets the frozen sections answer on their own — a number that
// leads the releases must not be mistaken for one that shipped. See AGENTS.md
// § "Two Version Numbers, And Which Question Each Answers".
//
// Runs in `pnpm test:scripts` (wired into the CI `quality` job), so any future
// drift fails a PR instead of silently rotting until the next docs build.

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..", "..");

test("upgrading.mdx has no stale %%PINCHY_VERSION%% section vs package.json version", () => {
  const pkgVersion = JSON.parse(
    readFileSync(resolve(ROOT, "package.json"), "utf8"),
  ).version;
  const mdx = readFileSync(
    resolve(ROOT, "docs/src/content/docs/guides/upgrading.mdx"),
    "utf8",
  );
  assert.doesNotThrow(() => assertNoStaleUpgradeSections(mdx, pkgVersion));
});
