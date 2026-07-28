/**
 * Drift guard for the repo's Node version pin.
 *
 * CI has always said `node-version: 22`. Nothing said it to a developer's
 * machine: there was no `.nvmrc` and no `engines` field, so a local Node could
 * drift arbitrarily far from CI's and nothing anywhere would mention it.
 *
 * Drift is invisible until a NATIVE module notices, and the notice is
 * disguised. On 2026-07-28 the whole `pinchy_read PDF integration` block in
 * packages/plugins/pinchy-files failed like this:
 *
 *   AssertionError: expected 'The module …/better_sqlite3.node was compiled
 *   against a different Node.js version using NODE_MODULE_VERSION 137. This
 *   version of Node.js requires NODE_MODULE_VERSION 141.' to contain
 *   '<document>'
 *
 * Local Node was v25.2.1 (ABI 141) against a module built for ABI 137. Note
 * the shape: pinchy-files returns the module loader's error as the tool's
 * RESULT rather than throwing, so an environment fault arrives as an ordinary
 * assertion failure on a product assertion. Nothing says "rebuild your native
 * modules"; the honest reading of that output is "the PDF path is broken", and
 * the next hours go into debugging code that is fine (pinchy#947).
 *
 * So the property guarded here is not "a version is written down somewhere" —
 * it is that every place that states one states the SAME one. Three can drift,
 * each silently:
 *   1. `.nvmrc` — what a developer's version manager picks up,
 *   2. `engines.node` — what the package manager will warn or refuse on,
 *   3. `node-version:` in every workflow — what CI actually runs.
 *
 * Bumping Node is a fine thing to do. Bumping it in one of these three is not,
 * and that is the act this guard makes loud.
 *
 * Read-side sibling of the format-gate / ci-path-filter / plugin-typecheck
 * guards (see AGENTS.md).
 */

/**
 * Read the major version out of an `.nvmrc`.
 *
 * Accepts what version managers accept: a bare major (`22`), a full version
 * (`22.14.0`), and an optional `v` prefix. Rejects aliases like `lts/*` — they
 * resolve to different versions over time and on different machines, which is
 * the drift this file exists to prevent, not a way to express a pin.
 *
 * @param {string} content
 * @returns {{ major: number } | { error: string }}
 */
export function parseNvmrc(content) {
  const trimmed = String(content ?? "").trim();
  if (!trimmed) return { error: ".nvmrc is empty" };

  const match = /^v?(\d+)(?:\.\d+){0,2}$/.exec(trimmed);
  if (!match) {
    return {
      error: `.nvmrc must hold a version, not an alias — found ${JSON.stringify(trimmed)}. Aliases like "lts/*" resolve differently over time and per machine.`,
    };
  }
  return { major: Number(match[1]) };
}

/**
 * The one `engines.node` range this repo accepts, for a given major.
 *
 * Deliberately a single exact shape rather than a semver-range evaluation.
 * The guard's job is to be unambiguous about what to write — `>=22` alone
 * admits Node 25, which is precisely the drift that started this — and an
 * exact string lets the failure message print the line to paste.
 *
 * @param {number} major
 * @returns {string}
 */
export function expectedEnginesRange(major) {
  return `>=${major} <${major + 1}`;
}

/**
 * Pull every `node-version:` value out of a workflow file's text.
 *
 * Text, not YAML: the guard must not need a YAML dependency to run under
 * `node --test`, and the shape it looks for is a single scalar on its own
 * line, which is how all three workflows write it. A `node-version` that is a
 * matrix reference (`${{ matrix.node }}`) is returned verbatim so the caller
 * can reject it rather than silently skip it.
 *
 * @param {string} yamlText
 * @returns {string[]}
 */
export function extractWorkflowNodeVersions(yamlText) {
  const versions = [];
  const pattern = /^[ \t]*node-version:[ \t]*(?:["']([^"']*)["']|([^\s#]+))/gm;
  let match;
  while ((match = pattern.exec(String(yamlText ?? ""))) !== null) {
    versions.push((match[1] ?? match[2] ?? "").trim());
  }
  return versions;
}

/**
 * @param {object} input
 * @param {string | null} input.nvmrc raw `.nvmrc` contents, or null if absent
 * @param {string | undefined} input.enginesNode root package.json `engines.node`
 * @param {Array<{ file: string, versions: string[] }>} input.workflows
 * @returns {string[]} one message per problem; empty means the pin is coherent
 */
export function validateNodeVersionPin({ nvmrc, enginesNode, workflows }) {
  const errors = [];

  if (nvmrc === null || nvmrc === undefined) {
    errors.push(
      "No .nvmrc at the repo root. Without it a version manager picks whatever Node is active, and the mismatch only surfaces when a native module fails to load.",
    );
    return errors;
  }

  const parsed = parseNvmrc(nvmrc);
  if ("error" in parsed) {
    errors.push(parsed.error);
    return errors;
  }
  const { major } = parsed;

  const expected = expectedEnginesRange(major);
  if (!enginesNode) {
    errors.push(
      `Root package.json has no engines.node. Add: "engines": { "node": "${expected}" } — it is what makes the mismatch a package-manager message instead of a native-module crash.`,
    );
  } else if (enginesNode.trim() !== expected) {
    errors.push(
      `Root package.json engines.node is ${JSON.stringify(enginesNode)}, expected ${JSON.stringify(expected)} to match .nvmrc (${major}). An open-ended ">=${major}" admits every future major, which is the drift this pin exists to stop.`,
    );
  }

  for (const { file, versions } of workflows) {
    if (versions.length === 0) continue;
    for (const version of versions) {
      const workflowMajor = parseNvmrc(version);
      if ("error" in workflowMajor) {
        errors.push(
          `${file} sets node-version: ${JSON.stringify(version)}, which is not a plain version. CI must run the same Node the pin names (${major}).`,
        );
        continue;
      }
      if (workflowMajor.major !== major) {
        errors.push(
          `${file} sets node-version: ${version} but .nvmrc says ${major}. Bump both, or local and CI stop agreeing about what Node runs.`,
        );
      }
    }
  }

  return errors;
}
