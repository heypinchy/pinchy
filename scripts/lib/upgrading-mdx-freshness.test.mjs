import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { assertNoStaleUpgradeSections } from "./release-logic.mjs";

// CI guard: the real docs/src/content/docs/guides/upgrading.mdx must not carry a
// stale `%%PINCHY_VERSION%%` left over from a release that forgot to freeze its
// section (the v0.5.8 miss). The "latest released version" is root
// package.json#version — on main it always equals the most recently released
// tag because `pnpm release` bumps it in the release commit.
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
