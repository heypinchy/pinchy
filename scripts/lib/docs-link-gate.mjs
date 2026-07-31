/**
 * Drift guard for the checks that read the BUILT docs site (#769).
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
 * The same conditions must hold for `check:rendered`
 * (`check-rendered-tables.mjs`), which catches the other way a built page lies:
 * v0.9.0 shipped every `.mdx` table as a paragraph of `|` characters, because
 * astro@6 deprecated `markdown.gfm` and @astrojs/mdx read the now-undefined
 * option. The build was green, the anchors were fine, and 41 of 69 live pages
 * were unreadable.
 *
 * All of which holds only as long as four things stay true per check, and each
 * of them can be undone while every check stays green:
 *   1. docs/package.json keeps declaring the script,
 *   2. that script keeps running the checker it is named for,
 *   3. CI's `quality` job keeps running BOTH `pnpm build` and the check, in
 *      that order — the checkers read the build's output, so a check that runs
 *      first reads a stale (or missing) dist/,
 *   4. CI keeps running the checkers' OWN unit tests. A checker rewritten to
 *      find nothing passes happily against a healthy dist/ — its tests are the
 *      only thing that would notice, and until #1007 they ran nowhere but on a
 *      developer's laptop.
 *
 * Same shape as the format-gate / web-typecheck / plugin-typecheck guards (see
 * AGENTS.md): make a silent narrowing of the gate a loud, deliberate act.
 */

/** Every check that reads `docs/dist/`. Adding one here wires its whole gate. */
const BUILT_OUTPUT_CHECKS = [
  { script: "check:anchors", file: "check-anchors.mjs" },
  { script: "check:rendered", file: "check-rendered-tables.mjs" },
];
const BUILD_COMMAND = "cd docs && pnpm build";
const checkCommand = (script) => `cd docs && pnpm ${script}`;

/**
 * The checkers' unit tests. The glob is pinned rather than the file list: a
 * narrowed glob (`scripts/check-anchors.test.mjs`) would silently drop the
 * other checkers' tests while the script name survives — the same narrowing
 * this whole guard exists to make loud.
 */
const TEST_SCRIPT = "test";
const TEST_GLOB = "scripts/*.test.mjs";
const TEST_COMMAND = `cd docs && pnpm ${TEST_SCRIPT}`;

/**
 * @param {unknown} pkg parsed docs/package.json
 * @returns {string[]} problems (empty = ok)
 */
export function validateDocsPackage(pkg) {
  if (pkg === null || typeof pkg !== "object" || Array.isArray(pkg)) {
    return ["docs/package.json must be a JSON object"];
  }
  const scripts =
    pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};

  const problems = [];
  for (const { script: name, file } of BUILT_OUTPUT_CHECKS) {
    const script = scripts[name];
    if (typeof script !== "string") {
      problems.push(`docs/package.json needs a "${name}" script`);
    } else if (!script.includes(file)) {
      problems.push(`"${name}" must run scripts/${file} (got "${script}")`);
    }
  }

  const testScript = scripts[TEST_SCRIPT];
  if (typeof testScript !== "string") {
    problems.push(`docs/package.json needs a "${TEST_SCRIPT}" script`);
  } else if (
    !testScript.includes("--test") ||
    !testScript.includes(TEST_GLOB)
  ) {
    problems.push(
      `"${TEST_SCRIPT}" must run \`node --test ${TEST_GLOB}\` (got "${testScript}")`,
    );
  }

  return problems;
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

  if (buildAt === -1) {
    problems.push(`CI's \`quality\` job must run \`${BUILD_COMMAND}\``);
  }

  for (const { script } of BUILT_OUTPUT_CHECKS) {
    const command = checkCommand(script);
    const checkAt = code.indexOf(command);

    if (checkAt === -1) {
      problems.push(`CI's \`quality\` job must run \`${command}\``);
      continue;
    }
    if (buildAt !== -1 && checkAt < buildAt) {
      // The checkers read docs/dist/. Running one first reads a missing dist (it
      // exits 1, loudly) or — worse, on a warm runner — a stale one, which is a
      // green check against yesterday's HTML.
      problems.push(
        `\`${command}\` must come AFTER \`${BUILD_COMMAND}\` — it reads the build's output`,
      );
    }
  }

  // No ordering constraint: these tests read their own fixtures, not dist/.
  if (code.indexOf(TEST_COMMAND) === -1) {
    problems.push(`CI's \`quality\` job must run \`${TEST_COMMAND}\``);
  }

  return problems;
}
