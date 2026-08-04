/**
 * Drift guard for `docs/src/content/docs/reference/environment-variables.mdx`
 * (#1082): every variable named in the root `.env.example` must appear on the
 * consolidated reference page, so the two can't quietly drift apart the way
 * the env-var docs did before that page existed — scattered across
 * installation/customizing-deployment/enterprise-setup, with no single place
 * that had to list every variable to stay correct.
 *
 * Deliberately narrow: `.env.example` is the file an operator actually opens,
 * and it is small and stable enough that a whole-word mention check is
 * reliable. It does not additionally scan every `docker-compose*.yml` for
 * `${VAR}` references — that set includes CI/test-only overlays
 * (docker-compose.eval.yml, docker-compose.integration.yml, …) with variables
 * no end-user reference page should document, and drawing the line between
 * "user-facing" and "test-infra" compose vars is a judgement call a script
 * can't make reliably. The six resource-limit variables from the base
 * `docker-compose.yml` are documented on the page by hand instead, alongside
 * the `.env.example` set this guard checks.
 */

/**
 * Pulls every variable name `.env.example` mentions, whether it's live
 * (`PINCHY_VERSION=v0.8.0`) or commented out as an optional example
 * (`# DB_PASSWORD=`). Both are things a reader might set, so both need a
 * home on the reference page.
 *
 * @param {string} source contents of .env.example
 * @returns {string[]} sorted, deduplicated variable names
 */
export function extractEnvExampleVars(source) {
  const names = new Set();
  for (const line of source.split("\n")) {
    const m = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line);
    if (m) names.add(m[1]);
  }
  return [...names].sort();
}

/**
 * Whether a doc page names an identifier as a whole word — same rule as
 * `mentions()` in docs-coverage.mjs, duplicated rather than imported so this
 * guard has no dependency on that module's exemption tables. `PINCHY_PORT`
 * must not be satisfied by a page that only mentions `PINCHY_PORT_OLD` or
 * similar.
 *
 * @param {string} mdx
 * @param {string} id
 * @returns {boolean}
 */
function mentions(mdx, id) {
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w])${escaped}(?![\\w])`).test(mdx);
}

/**
 * @param {string[]} vars from {@link extractEnvExampleVars}
 * @param {string} mdx contents of reference/environment-variables.mdx
 * @returns {string[]} problems (empty = ok)
 */
export function findUndocumentedEnvVars(vars, mdx) {
  return vars
    .filter((v) => !mentions(mdx, v))
    .map(
      (v) =>
        `"${v}" is in .env.example but not documented in ` +
        `docs/src/content/docs/reference/environment-variables.mdx`,
    );
}
