/**
 * Drift guard for the repo's ONE format gate.
 *
 * Until 2026-07 the gate was `pnpm --filter @pinchy/web format:check`: a check
 * called "Format check" that only ever read packages/web. Everything else —
 * scripts/ (28 files), every plugin (56), the config/ mock servers, the
 * compose overlays, docs/scripts — had never been formatted and nothing said
 * so. The check was green the entire time, because a gate reports on what it
 * looks at, not on what it should look at.
 *
 * So the property worth guarding is not "prettier runs" — it always did. It is
 * SCOPE, and scope can narrow three ways, each silent:
 *   1. the script stops being whole-tree (a glob list, or delegation to one
 *      package — that IS the original bug, spelled two different ways),
 *   2. CI stops running it,
 *   3. an ignore rule carves a source tree back out (see the coverage probe in
 *      format-gate.test.mjs, which is the half these validators can't express).
 *
 * A second prettier declaration is the fourth way: two versions disagree about
 * the same file, so whichever one CI resolves, somebody's local `pnpm format`
 * produces a diff the gate then rejects.
 *
 * Read-side sibling of the no-untracked-skips / no-test-deletion /
 * web-typecheck-gate guards (see AGENTS.md): it makes a silent narrowing of the
 * gate into a loud, deliberate act.
 */

const ROOT_PACKAGE_JSON = "package.json";

/**
 * @param {string} command
 * @returns {{ binary: string, tokens: string[] }}
 */
function parse(command) {
  const tokens = command.trim().split(/\s+/).filter(Boolean);
  return { binary: tokens[0] ?? "", tokens };
}

/**
 * @param {string} name script name, for the message
 * @param {string} command
 * @param {"--check" | "--write"} mode
 * @param {"--check" | "--write"} opposite
 * @returns {string[]}
 */
function validateInvocation(name, command, mode, opposite) {
  if (typeof command !== "string" || command.trim() === "") {
    return [`root package.json must declare a \`${name}\` script`];
  }
  const problems = [];
  const { binary, tokens } = parse(command);

  // Delegation (`pnpm --filter @pinchy/web format:check`) is how the gate got
  // scoped to one package in the first place, so it is not a stylistic nit.
  if (binary !== "prettier") {
    problems.push(
      `\`${name}\` must invoke prettier directly from the repo root (got \`${binary}\`); ` +
        `delegating to a package scopes the gate to that package, which is the bug this guard exists for`,
    );
  }
  if (!tokens.includes(mode)) {
    problems.push(`\`${name}\` must pass ${mode}`);
  }
  if (tokens.includes(opposite)) {
    problems.push(`\`${name}\` must not pass ${opposite}`);
  }
  // `.` — the whole tree. Ignore rules decide what is excluded, in one place
  // (.gitignore + .prettierignore), rather than a list here that rots silently.
  if (!tokens.slice(1).includes(".")) {
    problems.push(
      `\`${name}\` must target the whole tree (\`.\`); naming paths here means every path nobody ` +
        `thought of stays outside the gate while it still reports green`,
    );
  }
  const glob = tokens.find((t) => t.includes("*"));
  if (glob) {
    problems.push(
      `\`${name}\` must not carry a glob list (found \`${glob}\`); use \`.\` plus .prettierignore`,
    );
  }
  return problems;
}

/**
 * @param {Record<string, string>} scripts the root package.json `scripts` block
 * @returns {string[]} problems (empty = ok)
 */
export function validateFormatScripts(scripts) {
  if (
    scripts === null ||
    typeof scripts !== "object" ||
    Array.isArray(scripts)
  ) {
    return ["root package.json has no readable `scripts` block"];
  }
  return [
    ...validateInvocation(
      "format:check",
      scripts["format:check"],
      "--check",
      "--write",
    ),
    ...validateInvocation("format", scripts.format, "--write", "--check"),
  ];
}

/**
 * @param {{ path: string, version: string }[]} declarations every package.json
 *   in the repo that declares prettier, as repo-relative paths
 * @returns {string[]} problems (empty = ok)
 */
export function validatePrettierOwnership(declarations) {
  if (!Array.isArray(declarations))
    return ["prettier declarations are unreadable"];
  const problems = [];
  if (!declarations.some((d) => d.path === ROOT_PACKAGE_JSON)) {
    problems.push(
      `the root ${ROOT_PACKAGE_JSON} must declare prettier — the gate runs from the root, and an ` +
        `undeclared binary is not resolvable there`,
    );
  }
  for (const extra of declarations.filter(
    (d) => d.path !== ROOT_PACKAGE_JSON,
  )) {
    problems.push(
      `${extra.path} also declares prettier (${extra.version}); two declarations can resolve to two ` +
        `versions, which format the same file differently — one of them will always lose to the gate`,
    );
  }
  return problems;
}

/**
 * @param {string} ciYaml raw .github/workflows/ci.yml
 * @returns {string[]} problems (empty = ok)
 */
export function validateCiWiring(ciYaml) {
  if (typeof ciYaml !== "string") return ["ci.yml is unreadable"];
  // Strip YAML comments first. A commented-out step, or prose that merely names
  // the command, leaves the substring in the file while CI stops running the
  // gate — the same silent un-wiring the typecheck guard strips for. `#` counts
  // as a comment only at line start or after whitespace, so a `#` inside a
  // command string does not truncate the line.
  const withoutComments = ciYaml
    .split("\n")
    .map((line) => line.replace(/(^|\s)#.*$/, "$1"))
    .join("\n");
  return withoutComments.includes("pnpm format:check")
    ? []
    : ["CI (.github/workflows/ci.yml) must run `pnpm format:check`"];
}
