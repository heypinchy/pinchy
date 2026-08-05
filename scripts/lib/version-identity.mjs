/**
 * Pure logic for the version-identity guard.
 *
 * The repo carries the version number in six places, and until #1044 they
 * were treated as one number that `pnpm release` writes in one commit. That
 * held while every release was cut from `main`. Release branches ended it: both
 * 0.9.x releases were cut from `release/0.9`, so `main` never took the bump and
 * sat at `0.8.0` while v0.9.1 was the current release. Measured 2026-08-04.
 *
 * What that actually cost, in ascending order of how visible it is:
 *
 *  - `assertNoStaleUpgradeSections` was written on the premise "on main,
 *    package.json#version IS the newest released tag". It had to be taught
 *    `max(package.json, frozen tags)` to stay green — the premise was gone, and
 *    the guard was quietly working around it.
 *  - `/api/version` reports `package.json#version` via
 *    `NEXT_PUBLIC_PINCHY_VERSION`. Staging tracks `:next`, so it announced
 *    **0.8.0** for a build 400+ commits past it. Somebody checking whether their
 *    fix reached staging read a number two releases stale.
 *  - `.env.example` carries `PINCHY_VERSION=`, which is the image tag a user
 *    pulls. On `main` it said **v0.8.0**. That is not a cosmetic number; it is
 *    an install instruction, and it was pointing two releases back.
 *  - README.md's quick start pins the version TWICE — the `docker-compose.yml`
 *    it curls from a tag URL, and the `PINCHY_VERSION=` line it writes into
 *    `.env`, which is what that compose file resolves its images from. Both
 *    said **v0.8.0** — the most-read install instruction in the repo, the one a
 *    visitor runs off the GitHub front page, handing them a compose file two
 *    releases old. It is the reason this guard reads the README: the first pass
 *    of #1044 corrected `.env.example` and both marketplace templates and
 *    missed this one; the pass after that read the URL and missed the `.env`
 *    line beside it. Which is what an enumeration written by hand does, twice.
 *
 * So the two numbers have to stop being one:
 *
 *  - **`.env.example`, BOTH of the README quick start's pins and both
 *    marketplace templates answer "what should I pull?"** — always the newest
 *    RELEASED tag, because a tag that does not exist is not installable.
 *  - **`package.json` answers "what is this tree?"** — the newest release right
 *    at a release commit, and `<next>-dev` at every other moment, because a
 *    build 400 commits past v0.9.1 is not v0.9.1 and must not claim to be.
 *
 * The two marketplace templates are checked one hop away rather than here:
 * `marketplace-version.test.mjs` already pins both to `.env.example`, against
 * the real files. Duplicating that would give a second place to keep in sync,
 * which is the failure this whole section is about.
 *
 * `-dev` is deliberately not just any pre-release identifier: it is the one
 * spelling this guard accepts, so "is this a development tree?" stays a string
 * comparison rather than a semver-range question.
 *
 * The offline source of truth for "newest released tag" is upgrading.mdx's
 * newest frozen section. It is in the repo, needs no network and no tags
 * fetched, and it is already the thing a release must update — so a release
 * that forgets it fails here too.
 *
 * See AGENTS.md § "Two Version Numbers, And Which Question Each Answers".
 */

import { parseUpgradeSections } from "./upgrading-released-sections.mjs";
import { parseDeclaredVersion, compareVersions } from "./release-logic.mjs";

/**
 * The newest release upgrading.mdx records as shipped — its newest frozen
 * `to vX.Y.Z` heading. The open `%%PINCHY_VERSION%%` section is by definition
 * not released and is skipped.
 *
 * @param {string} mdx
 * @returns {string|null} e.g. "0.9.1", or null if the file records none
 */
export function newestFrozenRelease(mdx) {
  const frozen = parseUpgradeSections(mdx)
    .filter((s) => s.to !== "%%PINCHY_VERSION%%")
    .map((s) => s.to.slice(1));
  if (frozen.length === 0) return null;
  return frozen.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
}

/**
 * Reads `PINCHY_VERSION=` out of a .env.example.
 * @param {string} content
 * @returns {string|null} the raw value, e.g. "v0.9.1"
 */
export function readEnvExampleVersion(content) {
  const m = /^PINCHY_VERSION=(.*)$/m.exec(content);
  return m ? m[1].trim() : null;
}

/**
 * Every distinct version the README's quick start pins, in order.
 *
 * The quick start pins the version TWICE, and both are instructions rather than
 * labels — `pnpm release` bumps both, in `bumpReadmeQuickstartPins`:
 *
 *  1. `raw.githubusercontent.com/heypinchy/pinchy/v<X.Y.Z>/docker-compose.yml`,
 *     the URL a visitor curls off the GitHub front page, and
 *  2. `PINCHY_VERSION=v<X.Y.Z>`, written into `.env` — the tag that compose file
 *     resolves its images from (it refuses to start without it).
 *
 * Reading only the first would pass a README that installs one release's
 * compose topology with another release's images, which is silent by
 * construction: the reader's install succeeds. `readme-quickstart-gate.mjs`
 * checks the two agree with each other; this checks they agree with the newest
 * release, and neither implies the other.
 *
 * ALL pins are returned rather than the first, because the bumper rewrites all
 * of them; a reader that stopped at one would pass a README where a second copy
 * of the command had drifted.
 *
 * @param {string} content - raw README.md contents
 * @returns {string[]} e.g. ["v0.9.1"], empty when the README pins none
 */
export function readReadmeVersionPins(content) {
  const patterns = [
    /raw\.githubusercontent\.com\/heypinchy\/pinchy\/(v\d+\.\d+\.\d+)\/docker-compose\.yml/g,
    /PINCHY_VERSION=(v\d+\.\d+\.\d+)/g,
  ];
  const pins = patterns.flatMap((re) =>
    [...content.matchAll(re)].map((m) => m[1]),
  );
  return [...new Set(pins)];
}

/**
 * The whole contract, in one place.
 *
 * @param {object} args
 * @param {string} args.rootVersion - root package.json#version
 * @param {string} args.webVersion - packages/web/package.json#version
 * @param {string} args.envExample - raw .env.example contents
 * @param {string} args.readme - raw README.md contents
 * @param {string} args.mdx - raw upgrading.mdx contents
 * @returns {string[]} problems, empty when the tree is consistent
 */
export function checkVersionIdentity({
  rootVersion,
  webVersion,
  envExample,
  readme,
  mdx,
}) {
  const problems = [];

  const newest = newestFrozenRelease(mdx);
  if (newest == null) {
    return [
      "upgrading.mdx records no frozen release section, so there is nothing to " +
        "check the declared versions against. That file is the offline source of " +
        "truth for 'newest released tag'.",
    ];
  }

  let declared;
  try {
    declared = parseDeclaredVersion(rootVersion);
  } catch (err) {
    return [`Root package.json: ${err.message}`];
  }

  if (rootVersion !== webVersion) {
    problems.push(
      `Root package.json says ${rootVersion}, packages/web says ${webVersion}. ` +
        `They are bumped together by \`pnpm release\` and must not diverge.`,
    );
  }

  // The bug this guard exists for: a tree that claims to BE an older release
  // than the one it already contains.
  const order = compareVersions(declared.released, newest);
  if (declared.isDev) {
    if (order <= 0) {
      problems.push(
        `package.json declares ${rootVersion}, but v${newest} has already shipped. ` +
          `A development version must be AHEAD of the newest release — set it to the ` +
          `next release's number with a \`-dev\` suffix.`,
      );
    }
  } else if (order !== 0) {
    problems.push(
      `package.json declares ${rootVersion} while the newest released version is ` +
        `v${newest}. Without a \`-dev\` suffix this claims to BE a release, so it has ` +
        `to be that release.\n` +
        (order < 0
          ? `  This is the state that shipped v0.9.1 while \`main\` said 0.8.0: a release ` +
            `cut from a release branch does not bump \`main\`. Set it to ` +
            `<next>-dev after the cut.`
          : `  It is ahead of every release, so it is a development tree — say so with ` +
            `\`-dev\`.`),
    );
  }

  // .env.example is an install instruction, not a version label.
  const envValue = readEnvExampleVersion(envExample);
  if (envValue == null) {
    problems.push(
      "No PINCHY_VERSION= line in .env.example — nothing tells a new install " +
        "which image to pull.",
    );
  } else if (envValue !== `v${newest}`) {
    problems.push(
      `.env.example pins PINCHY_VERSION=${envValue}, but the newest release is ` +
        `v${newest}. That line is the image tag a new install pulls, so it must name ` +
        `a tag that exists and is current — never a \`-dev\` version, and never a ` +
        `release that has been superseded.`,
    );
  }

  // So is the README quick start, and it is the one a visitor actually runs.
  const readmePins = readReadmeVersionPins(readme);
  if (readmePins.length === 0) {
    problems.push(
      "README.md pins no version in its quick start — neither a " +
        "raw.githubusercontent.com/heypinchy/pinchy/v<version>/docker-compose.yml " +
        "URL nor a PINCHY_VERSION=v<version> line. The install pins moved or were " +
        "removed — this guard and `bumpReadmeQuickstartPins` both read them, so " +
        "both stop working silently.",
    );
  } else {
    const stale = readmePins.filter((p) => p !== `v${newest}`);
    if (stale.length > 0) {
      problems.push(
        `README.md's quick start pins ${stale.join(", ")}, but the newest release is ` +
          `v${newest}. It pins the version twice — the curl'd docker-compose.yml and ` +
          `the PINCHY_VERSION= line that compose file resolves its images from — and ` +
          `it is the most-read install instruction the repo has, run off the GitHub ` +
          `front page. It drifts exactly like .env.example does: \`pnpm release\` bumps ` +
          `it on the branch it runs on, so a release cut from a release branch leaves ` +
          `\`main\` behind.`,
      );
    }
  }

  return problems;
}
