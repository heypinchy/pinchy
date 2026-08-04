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
 * Pure functions only — all I/O happens in the caller (the guard test).
 * Mirrors the shape of docs-link-gate.mjs / format-gate.mjs.
 */

const QUICKSTART_HEADING = /^## Quick Start\s*$/m;

/**
 * Extracts the first fenced ```bash code block that appears after the
 * "## Quick Start" heading.
 * @param {string} readme - raw README.md contents
 * @returns {string} the code block's contents (without the fences)
 * @throws {Error} if the heading, or a ```bash block after it, is missing
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
  const blockMatch = /```bash\n([\s\S]*?)```/.exec(after);
  if (!blockMatch) {
    throw new Error(
      'No ```bash code block found after the "## Quick Start" heading',
    );
  }
  return blockMatch[1];
}

/**
 * Validates that the quickstart block sets PINCHY_VERSION before it runs
 * `docker compose up`. Equivalent forms (e.g. exporting the variable, or
 * writing it into `.env` via `echo`/redirect) all satisfy this — the point
 * is only that SOME line naming PINCHY_VERSION precedes the start command,
 * matching the pattern already used in installation.mdx / getting-started.mdx.
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
  const setsVersion = before.some((line) => /PINCHY_VERSION/.test(line));
  if (!setsVersion) {
    return [
      'quickstart block runs "docker compose up" without setting PINCHY_VERSION first. ' +
        "docker-compose.yml refuses to start without it " +
        "(`PINCHY_VERSION:?set PINCHY_VERSION in .env`), so the first command a reader copies " +
        'fails. Add a line like `echo "PINCHY_VERSION=vX.Y.Z" > .env` before `docker compose up`.',
    ];
  }
  return [];
}
