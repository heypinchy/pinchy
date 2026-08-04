/**
 * Pure logic for the version-identity guard.
 *
 * The repo carries the version number in three places, and until #1044 they
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
 *
 * So the two numbers have to stop being one:
 *
 *  - **`.env.example` answers "what should I pull?"** — always the newest
 *    RELEASED tag, because a tag that does not exist is not installable.
 *  - **`package.json` answers "what is this tree?"** — the newest release right
 *    at a release commit, and `<next>-dev` at every other moment, because a
 *    build 400 commits past v0.9.1 is not v0.9.1 and must not claim to be.
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
 * The whole contract, in one place.
 *
 * @param {object} args
 * @param {string} args.rootVersion - root package.json#version
 * @param {string} args.webVersion - packages/web/package.json#version
 * @param {string} args.envExample - raw .env.example contents
 * @param {string} args.mdx - raw upgrading.mdx contents
 * @returns {string[]} problems, empty when the tree is consistent
 */
export function checkVersionIdentity({
  rootVersion,
  webVersion,
  envExample,
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

  return problems;
}
