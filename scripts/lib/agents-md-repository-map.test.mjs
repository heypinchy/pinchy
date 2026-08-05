import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  extractRepositoryMapPlugins,
  discoverPluginPackages,
  checkRepositoryMapPlugins,
} from "./agents-md-repository-map.mjs";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

/** A Repository Map section shaped like the real one. */
function repositoryMap(pluginsBullet) {
  return [
    "# AGENTS.md - Pinchy",
    "",
    "## Repository Map",
    "",
    "- `packages/web/` - Next.js app.",
    pluginsBullet,
    "- `config/` - OpenClaw config support.",
    "",
    "## Tech Stack",
    "",
    "- `packages/plugins/` - OpenClaw plugins. Current Pinchy plugins: `pinchy-ghost`.",
  ].join("\n");
}

const REAL_SHAPE =
  "- `packages/plugins/` - OpenClaw plugins. Current Pinchy plugins: `pinchy-files`, `pinchy-context`, `pinchy-web`.";

test("extractRepositoryMapPlugins reads the backticked names after the marker", () => {
  assert.deepEqual(extractRepositoryMapPlugins(repositoryMap(REAL_SHAPE)), [
    "pinchy-files",
    "pinchy-context",
    "pinchy-web",
  ]);
});

test("extractRepositoryMapPlugins reads only the Repository Map section", () => {
  // The decoy bullet below "## Tech Stack" must not contribute: a guard that
  // reads the whole file would accept a list that lives anywhere at all.
  const plugins = extractRepositoryMapPlugins(repositoryMap(REAL_SHAPE));
  assert.ok(!plugins.includes("pinchy-ghost"));
});

test("extractRepositoryMapPlugins stops at the end of the list sentence", () => {
  // The list is a sentence, not a line. Reading to the line end swallows the
  // backticks of anything written after it — the bullet's own pointer at this
  // guard was read as a ninth plugin the moment it was added.
  assert.deepEqual(
    extractRepositoryMapPlugins(
      repositoryMap(
        "- `packages/plugins/` - OpenClaw plugins. Current Pinchy plugins: `pinchy-files`, `pinchy-web`. Guarded by `scripts/lib/agents-md-repository-map.test.mjs`.",
      ),
    ),
    ["pinchy-files", "pinchy-web"],
  );
});

test("extractRepositoryMapPlugins throws when the section is gone", () => {
  const md = [
    "# AGENTS.md - Pinchy",
    "",
    "## Tech Stack",
    "",
    "- Next.js",
  ].join("\n");
  assert.throws(() => extractRepositoryMapPlugins(md), /Repository Map/);
});

test("extractRepositoryMapPlugins throws when the plugins bullet is gone", () => {
  const md = ["## Repository Map", "", "- `config/` - stuff.", ""].join("\n");
  assert.throws(() => extractRepositoryMapPlugins(md), /packages\/plugins/);
});

test("extractRepositoryMapPlugins throws when the bullet is reworded past the marker", () => {
  // Reading a reworded bullet as "no plugins documented" would report every
  // plugin as missing; reading it as an empty corpus would report none. Both
  // are worse than saying the sentence no longer parses.
  assert.throws(
    () =>
      extractRepositoryMapPlugins(
        repositoryMap("- `packages/plugins/` - OpenClaw plugins live here."),
      ),
    /Current Pinchy plugins/,
  );
});

test("extractRepositoryMapPlugins throws when the marker is followed by no names", () => {
  assert.throws(
    () =>
      extractRepositoryMapPlugins(
        repositoryMap(
          "- `packages/plugins/` - OpenClaw plugins. Current Pinchy plugins: none yet.",
        ),
      ),
    /no plugin names/,
  );
});

test("checkRepositoryMapPlugins passes when both sides name the same set", () => {
  // Order is prose's business (the list groups internal before external), so
  // only the set is checked.
  assert.deepEqual(
    checkRepositoryMapPlugins(
      ["pinchy-web", "pinchy-files"],
      ["pinchy-files", "pinchy-web"],
    ),
    [],
  );
});

test("checkRepositoryMapPlugins flags a plugin on disk the map omits", () => {
  // The exact drift this guard exists to catch: pinchy-knowledge shipped with a
  // manifest, a tool and its own E2E coverage, and never reached the prose.
  const problems = checkRepositoryMapPlugins(
    ["pinchy-files"],
    ["pinchy-files", "pinchy-knowledge"],
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pinchy-knowledge/);
  assert.match(problems[0], /packages\/plugins/);
});

test("checkRepositoryMapPlugins flags a name the map keeps after the directory is gone", () => {
  const problems = checkRepositoryMapPlugins(
    ["pinchy-files", "pinchy-retired"],
    ["pinchy-files"],
  );
  assert.equal(problems.length, 1);
  assert.match(problems[0], /pinchy-retired/);
});

test("discoverPluginPackages reads the real plugin directories off disk", () => {
  const plugins = discoverPluginPackages(REPO_ROOT);
  assert.ok(plugins.includes("pinchy-files"));
  assert.ok(plugins.includes("pinchy-knowledge"));
  // A corpus floor: a walker that found nothing would otherwise agree with a
  // map that documented nothing.
  assert.ok(plugins.length >= 8, `only found ${plugins.length} plugins`);
});

test("discoverPluginPackages throws when the plugins directory is unreadable", () => {
  assert.throws(
    () => discoverPluginPackages(join(REPO_ROOT, "does-not-exist")),
    /packages\/plugins/,
  );
});

test("the real AGENTS.md Repository Map names exactly the plugins on disk", () => {
  const markdown = readFileSync(join(REPO_ROOT, "AGENTS.md"), "utf8");
  assert.deepEqual(
    checkRepositoryMapPlugins(
      extractRepositoryMapPlugins(markdown),
      discoverPluginPackages(REPO_ROOT),
    ),
    [],
  );
});
