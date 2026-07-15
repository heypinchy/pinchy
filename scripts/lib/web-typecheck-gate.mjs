/**
 * Drift guard for the packages/web test-typecheck gate.
 *
 * The gate (`pnpm -C packages/web typecheck` →
 * `tsc --noEmit -p tsconfig.typecheck.json`) is the ONLY thing in CI that
 * type-checks the web package's test files — `next build` type-checks
 * packages/web but its tsconfig deliberately EXCLUDES `*.test.ts(x)`. So the
 * gate only keeps protecting test files as long as three things stay true:
 *   1. tsconfig.typecheck.json keeps INCLUDING test files and never re-excludes
 *      them,
 *   2. the `typecheck` script keeps pointing at that config, and
 *   3. CI keeps running it.
 *
 * This is the read-side sibling of the no-untracked-skips / no-test-deletion /
 * plugin-typecheck guards (see AGENTS.md): it forces a silent narrowing of the
 * gate to be a loud, deliberate act.
 */

// Substrings that mean an exclude entry would drop test files from the gate.
const TEST_FILE_MARKERS = [".test.", ".spec.", "__tests__"];

/**
 * @param {unknown} config parsed tsconfig.typecheck.json
 * @returns {string[]} problems (empty = ok)
 */
export function validateTypecheckTsconfig(config) {
  if (config === null || typeof config !== "object" || Array.isArray(config)) {
    return ["tsconfig.typecheck.json must be a JSON object"];
  }
  const problems = [];
  const include = Array.isArray(config.include) ? config.include : [];
  if (!include.some((g) => typeof g === "string" && g.includes("src/**"))) {
    problems.push('include must contain a "src/**/*" glob so test files are type-checked');
  }
  const exclude = Array.isArray(config.exclude) ? config.exclude : [];
  for (const pat of exclude) {
    if (typeof pat === "string" && TEST_FILE_MARKERS.some((m) => pat.includes(m))) {
      problems.push(`exclude must not drop test files, but excludes "${pat}"`);
    }
  }
  return problems;
}

/**
 * @param {unknown} pkg parsed packages/web/package.json
 * @returns {string[]} problems (empty = ok)
 */
export function validateTypecheckScript(pkg) {
  const script =
    pkg && typeof pkg === "object" && pkg.scripts && typeof pkg.scripts === "object"
      ? pkg.scripts.typecheck
      : undefined;
  if (typeof script !== "string") {
    return ['packages/web/package.json needs a "typecheck" script'];
  }
  const problems = [];
  if (!/\btsc\b/.test(script)) problems.push('"typecheck" must run tsc');
  if (!script.includes("tsconfig.typecheck.json")) {
    problems.push('"typecheck" must use tsconfig.typecheck.json');
  }
  return problems;
}

/**
 * @param {unknown} ciYaml raw .github/workflows/ci.yml text
 * @returns {string[]} problems (empty = ok)
 */
export function validateCiWiring(ciYaml) {
  if (typeof ciYaml !== "string") return ["ci.yml is unreadable"];
  return ciYaml.includes("packages/web typecheck")
    ? []
    : ["CI (.github/workflows/ci.yml) must run `pnpm -C packages/web typecheck`"];
}
