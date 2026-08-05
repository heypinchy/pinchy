/**
 * Drift guard for the README "Quick Start" code block.
 *
 * `docker-compose.yml` refuses to start without a pinned version
 * (`PINCHY_VERSION:?set PINCHY_VERSION in .env`), but the README quickstart
 * used to `curl` the compose file straight into `docker compose up -d` with
 * no `.env` in between — the very first command a reader copies would fail.
 * `docs/src/content/docs/installation.mdx` and `getting-started.mdx` already
 * carry the correct `echo "PINCHY_VERSION=..." > .env` step; the README
 * quickstart was the one place that never got it.
 *
 * The block therefore carries two version pins — the curl'd compose URL and
 * the `PINCHY_VERSION=` value — and they must name the same release. A block
 * where they disagree is the failure mode NOT to trade the original one for:
 * the reader's first command succeeds, so nothing surfaces, and they run the
 * previous release's images against the new release's compose topology.
 *
 * Pure functions only — all I/O happens in the caller (the guard test).
 * Mirrors the shape of docs-link-gate.mjs / format-gate.mjs.
 */

const QUICKSTART_HEADING = /^## Quick Start\s*$/m;

/** The curl'd compose-file pin, e.g. `.../pinchy/v0.9.1/docker-compose.yml`. */
const COMPOSE_URL_PIN =
  /raw\.githubusercontent\.com\/heypinchy\/pinchy\/(v\d+\.\d+\.\d+)\/docker-compose\.yml/;

/**
 * The `.env` pin the compose file resolves its image tags from. Exported so
 * main-version-pins.mjs reads the same pattern rather than keeping a second
 * copy of it — a duplicated regex over the same file is exactly the paired
 * list this repo pins with drift guards everywhere else.
 */
export const ENV_VERSION_PIN = /PINCHY_VERSION=(v\d+\.\d+\.\d+)/;

/**
 * Whether a line actually assigns PINCHY_VERSION, as opposed to merely
 * mentioning it. A commented-out or explanatory line ("# PINCHY_VERSION is
 * set below") reads as prose to a human and would be a false green here.
 * @param {string} line
 * @returns {boolean}
 */
function assignsPinchyVersion(line) {
  if (/^\s*#/.test(line)) return false;
  return /PINCHY_VERSION=/.test(line);
}

/**
 * Extracts the first fenced ```bash code block inside the "## Quick Start"
 * section — i.e. between that heading and the next `## ` heading.
 *
 * The section bound is load-bearing: an unbounded search would, if the
 * quickstart block were ever removed, silently validate whatever bash block
 * came next in the README and report on the wrong thing.
 *
 * @param {string} readme - raw README.md contents
 * @returns {string} the code block's contents (without the fences)
 * @throws {Error} if the heading, or a ```bash block inside its section, is missing
 */
export function extractQuickstartBlock(readme) {
  if (typeof readme !== "string") {
    throw new Error("README is unreadable");
  }
  const headingMatch = QUICKSTART_HEADING.exec(readme);
  if (!headingMatch) {
    throw new Error('README has no "## Quick Start" heading');
  }
  const after = readme.slice(headingMatch.index + headingMatch[0].length);
  const nextHeading = /^## /m.exec(after);
  const section = nextHeading ? after.slice(0, nextHeading.index) : after;
  const blockMatch = /```bash\n([\s\S]*?)```/.exec(section);
  if (!blockMatch) {
    throw new Error(
      'No ```bash code block found in the "## Quick Start" section',
    );
  }
  return blockMatch[1];
}

/**
 * Validates that the quickstart block sets PINCHY_VERSION before it runs
 * `docker compose up`. Equivalent forms (exporting the variable, or writing
 * it into `.env` via `echo`/redirect, or prefixing the command) all satisfy
 * this — the point is only that some line ASSIGNS PINCHY_VERSION before the
 * start command, matching the pattern already used in installation.mdx /
 * getting-started.mdx.
 * @param {string} block - the quickstart bash block's contents
 * @returns {string[]} problems (empty = ok)
 */
export function validateQuickstartSetsVersion(block) {
  if (typeof block !== "string") {
    return ["quickstart block is unreadable"];
  }
  const lines = block.split("\n");
  const upIndex = lines.findIndex((line) => /docker compose up/.test(line));
  if (upIndex === -1) {
    return [
      'quickstart block has no "docker compose up" command to check against',
    ];
  }
  const before = lines.slice(0, upIndex);
  if (!before.some(assignsPinchyVersion)) {
    return [
      'quickstart block runs "docker compose up" without setting PINCHY_VERSION first. ' +
        "docker-compose.yml refuses to start without it " +
        "(`PINCHY_VERSION:?set PINCHY_VERSION in .env`), so the first command a reader copies " +
        'fails. Add a line like `echo "PINCHY_VERSION=vX.Y.Z" > .env` before `docker compose up`.',
    ];
  }
  return [];
}

/**
 * Validates that the block's two version pins name the same release.
 *
 * `pnpm release` bumps both (`bumpReadmeQuickstartPins`), so a divergence
 * means one of them was edited by hand or the bumper stopped covering one.
 * Unlike the missing-`.env` bug, this one is invisible to the reader: the
 * install succeeds and quietly runs the older release's images against the
 * newer release's compose file.
 *
 * @param {string} block - the quickstart bash block's contents
 * @returns {string[]} problems (empty = ok)
 */
export function validateQuickstartVersionsAgree(block) {
  if (typeof block !== "string") {
    return ["quickstart block is unreadable"];
  }
  const problems = [];
  const composeUrlMatch = COMPOSE_URL_PIN.exec(block);
  const envVersionMatch = ENV_VERSION_PIN.exec(block);
  if (!composeUrlMatch) {
    problems.push(
      "quickstart block has no pinned docker-compose URL " +
        "(raw.githubusercontent.com/heypinchy/pinchy/vX.Y.Z/docker-compose.yml). " +
        "An unpinned install is not reproducible, and `pnpm release` cannot bump what it cannot find.",
    );
  }
  if (!envVersionMatch) {
    problems.push(
      "quickstart block pins no PINCHY_VERSION=vX.Y.Z value. " +
        "`pnpm release` bumps this line, so a version written any other way drifts behind every release.",
    );
  }
  if (composeUrlMatch && envVersionMatch) {
    const [, composeVersion] = composeUrlMatch;
    const [, envVersion] = envVersionMatch;
    if (composeVersion !== envVersion) {
      problems.push(
        `quickstart pins disagree: the curl'd docker-compose.yml is ${composeVersion} ` +
          `but PINCHY_VERSION is ${envVersion}. The reader gets ${composeVersion}'s compose ` +
          `topology running ${envVersion}'s images, and nothing fails to tell them. ` +
          "Both pins are bumped together by `pnpm release` (bumpReadmeQuickstartPins) — " +
          "if they drifted, that bumper stopped covering one of them.",
      );
    }
  }
  return problems;
}
