// What `%%PINCHY_VERSION%%` resolves to when nobody says.
//
// Two real callers pass the version: release.yml (from the tag) and docs.yml
// (a required input). There is a THIRD, and it is the one this fallback's first
// shape overlooked — CI's `quality` job runs `cd docs && pnpm build` on every
// PR with no PINCHY_VERSION anywhere, and so does every developer running
// `pnpm -C docs build` locally. Neither publishes anything, and `quality` is a
// required check: this path has to RESOLVE, not refuse.
//
// It used to read `packages/web/package.json`, which WAS the newest released
// tag until #1044 split "what should I pull?" from "what is this tree?". On a
// `<next>-dev` tree that reading names a tag nobody can pull — the reason the
// first attempt refused it — but refusing turns `quality` red on every PR.
// upgrading.mdx's newest frozen section answers the question the docs actually
// ask, is in the repo (no tags to fetch), and always names a tag that exists.
// It is the same offline source of truth `version-identity.mjs` reads.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  cpSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const UPGRADING_MDX = "docs/src/content/docs/guides/upgrading.mdx";

const MDX = [
  "## Upgrading from v0.9.1 to %%PINCHY_VERSION%%",
  "",
  "Open — not released, so not an answer.",
  "",
  "## Upgrading from v0.9.0 to v0.9.1",
  "",
  "Shipped.",
  "",
  "## Upgrading from v0.8.0 to v0.9.0",
  "",
  "Shipped.",
  "",
].join("\n");

/**
 * A repo-shaped tree holding just the files the resolution path reads. The temp
 * dir is not a git repo, so `git describe` finds nothing and the fallback is
 * what runs — which is the point.
 */
function setupRepoLikeTree({ declaredVersion, mdx = MDX }) {
  const root = mkdtempSync(path.join(tmpdir(), "pinchy-docs-version-"));
  mkdirSync(path.join(root, path.dirname(UPGRADING_MDX)), { recursive: true });
  mkdirSync(path.join(root, "docs", "src", "snippets"), { recursive: true });
  mkdirSync(path.join(root, "docs", "public"), { recursive: true });
  mkdirSync(path.join(root, "packages", "web"), { recursive: true });

  writeFileSync(path.join(root, UPGRADING_MDX), mdx);
  writeFileSync(
    path.join(root, "docs", "src", "snippets", "cloud-init.yml"),
    "version: %%PINCHY_VERSION%%\n",
  );
  writeFileSync(
    path.join(root, "packages", "web", "package.json"),
    `${JSON.stringify({ version: declaredVersion })}\n`,
  );

  // Whole directories rather than a list of modules: the resolver imports
  // scripts/lib, and a list goes stale the first time something in there grows
  // an import — silently, because a module it cannot load reads as "no version".
  for (const dir of [
    ["scripts", "lib"],
    ["docs", "scripts"],
  ]) {
    cpSync(path.join(REPO_ROOT, ...dir), path.join(root, ...dir), {
      recursive: true,
    });
  }
  return root;
}

function inject(root, version) {
  const env = { ...process.env };
  if (version === undefined) delete env.PINCHY_VERSION;
  else env.PINCHY_VERSION = version;
  execFileSync(
    "sh",
    [path.join(root, "docs", "scripts", "inject-version.sh")],
    {
      env,
      stdio: "pipe",
    },
  );
  const marker = path.join(root, "docs", ".injected-version");
  return existsSync(marker) ? readFileSync(marker, "utf8").trim() : null;
}

test("a `-dev` tree resolves to the newest release upgrading.mdx records", () => {
  const root = setupRepoLikeTree({ declaredVersion: "0.10.0-dev" });
  try {
    assert.equal(inject(root), "v0.9.1");
    assert.equal(
      readFileSync(path.join(root, "docs", "public", "cloud-init.yml"), "utf8"),
      "version: v0.9.1\n",
      "the generated cloud-init must carry a tag a reader can actually pull",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the declared version is not consulted, even when it is a plain release", () => {
  // The two agreed for the repo's whole history, which is why reading
  // package.json looked correct for so long. They disagree here on purpose:
  // upgrading.mdx is the one that answers "which tag exists".
  const root = setupRepoLikeTree({ declaredVersion: "0.8.0" });
  try {
    assert.equal(inject(root), "v0.9.1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an explicit PINCHY_VERSION still wins over the fallback", () => {
  const root = setupRepoLikeTree({ declaredVersion: "0.10.0-dev" });
  try {
    assert.equal(inject(root, "v1.2.3"), "v1.2.3");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file recording no released section leaves the placeholders alone", () => {
  // The pre-existing contract for "could not determine": warn, exit 0, leave
  // `%%PINCHY_VERSION%%` standing. A wrong version is worse than a visible
  // placeholder, and this is the branch a repo with nothing released takes.
  const root = setupRepoLikeTree({
    declaredVersion: "0.1.0-dev",
    mdx: "## Upgrading from v0.0.1 to %%PINCHY_VERSION%%\n\nNothing shipped.\n",
  });
  try {
    assert.equal(inject(root), null, "nothing was injected, so no marker");
    assert.equal(
      readFileSync(path.join(root, UPGRADING_MDX), "utf8").includes(
        "%%PINCHY_VERSION%%",
      ),
      true,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// The resolver on its own, against the real repo — so a change to
// upgrading.mdx's shape fails here rather than in a docs build.
test("the resolver names this repo's newest frozen release", async () => {
  const { newestFrozenRelease } = await import(
    path.join(REPO_ROOT, "scripts", "lib", "version-identity.mjs")
  );
  const expected = newestFrozenRelease(
    readFileSync(path.join(REPO_ROOT, UPGRADING_MDX), "utf8"),
  );
  assert.ok(expected, "upgrading.mdx must record at least one shipped release");

  const printed = execFileSync(
    "node",
    [path.join(REPO_ROOT, "docs", "scripts", "newest-released-version.mjs")],
    { encoding: "utf8" },
  ).trim();
  assert.equal(printed, expected);
});
