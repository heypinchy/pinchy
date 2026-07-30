/**
 * Drift guard for the docs in-page anchor check (#769).
 *
 * A broken anchor inside `docs/` — `[see the config](/guides/setup/#nope)` —
 * used to be caught by nothing. The `links` job (lychee) passes
 * `--exclude-path docs` because the source `.mdx` links are routes into the
 * GENERATED site, not files on disk, and the astro build itself is perfectly
 * happy with a link to a heading that does not exist.
 *
 * The check is `docs/scripts/check-anchors.mjs`, which reads the BUILT site in
 * `docs/dist/`. That placement is what makes it cheap and un-skippable: CI's
 * `quality` job already builds the docs, `quality` is ungated (it is a required
 * check), and the same two commands an author runs locally fail the same way.
 *
 * All of which holds only as long as three things stay true, and each of them
 * can be undone while every check stays green:
 *   1. docs/package.json keeps declaring the `check:anchors` script,
 *   2. that script keeps running check-anchors.mjs,
 *   3. CI's `quality` job keeps running BOTH `pnpm build` and
 *      `pnpm check:anchors`, in that order — the checker reads the build's
 *      output, so a check that runs first reads a stale (or missing) dist/.
 *
 * Same shape as the format-gate / web-typecheck / plugin-typecheck guards (see
 * AGENTS.md): make a silent narrowing of the gate a loud, deliberate act.
 */

const SCRIPT_NAME = "check:anchors";
const SCRIPT_FILE = "check-anchors.mjs";
const BUILD_COMMAND = "cd docs && pnpm build";
const CHECK_COMMAND = `cd docs && pnpm ${SCRIPT_NAME}`;

/**
 * @param {unknown} pkg parsed docs/package.json
 * @returns {string[]} problems (empty = ok)
 */
export function validateDocsPackage(pkg) {
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
    return ["docs/package.json must be a JSON object"];
  }
  const scripts = pkg.scripts;
  const script =
    scripts && typeof scripts === "object" ? scripts[SCRIPT_NAME] : undefined;

  if (typeof script !== "string") {
    return [`docs/package.json needs a "${SCRIPT_NAME}" script`];
  }
  return script.includes(SCRIPT_FILE)
    ? []
    : [`"${SCRIPT_NAME}" must run scripts/${SCRIPT_FILE} (got "${script}")`];
}

/**
 * @param {unknown} qualityJobBody the `quality` job's text from ci.yml
 * @returns {string[]} problems (empty = ok)
 */
export function validateCiWiring(qualityJobBody) {
  if (typeof qualityJobBody !== "string") return ["ci.yml is unreadable"];

  // Same conservative comment strip as the web-typecheck guard: a `#` only
  // starts a YAML comment at line start or after whitespace, so a `#` inside a
  // command string does not truncate the line. Without this, a commented-out
  // step — or a step's prose comment that merely names the command — would
  // satisfy a substring match while CI ran nothing.
  const code = qualityJobBody
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");

  const problems = [];
  const buildAt = code.indexOf(BUILD_COMMAND);
  const checkAt = code.indexOf(CHECK_COMMAND);

  if (buildAt === -1) {
    problems.push(`CI's \`quality\` job must run \`${BUILD_COMMAND}\``);
  }
  if (checkAt === -1) {
    problems.push(`CI's \`quality\` job must run \`${CHECK_COMMAND}\``);
  }
  if (buildAt !== -1 && checkAt !== -1 && checkAt < buildAt) {
    // The checker reads docs/dist/. Running it first reads a missing dist (it
    // exits 1, loudly) or — worse, on a warm runner — a stale one, which is a
    // green check against yesterday's HTML.
    problems.push(
      `\`${CHECK_COMMAND}\` must come AFTER \`${BUILD_COMMAND}\` — it reads the build's output`,
    );
  }
  return problems;
}
