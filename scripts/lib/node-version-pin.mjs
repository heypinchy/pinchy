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
 * it is that every place that states one states the SAME one. Four can drift,
 * each silently:
 *   1. `.nvmrc` — what a developer's version manager picks up,
 *   2. `engines.node` — what the package manager will warn or refuse on,
 *   3. `node-version:` in every workflow — what CI actually runs,
 *   4. `FROM …node:<major>` in every Dockerfile — what SHIPS.
 *
 * The fourth is the one it is tempting to forget and the worst one to get
 * wrong. `better-sqlite3` is compiled inside those images, so a Dockerfile on
 * a different major than the pin reproduces the mismatch above in production
 * instead of on a laptop — and the laptop at least gets a stack trace. Eleven
 * Dockerfiles name a node image here (runtime, dev, and every E2E mock), which
 * is exactly the count that makes hand-checking them unreliable.
 *
 * Bumping Node is a fine thing to do. Bumping it in some of these four is not,
 * and that is the act this guard makes loud.
 *
 * Read-side sibling of the format-gate / ci-path-filter / plugin-typecheck
 * guards (see AGENTS.md).
 */

/**
 * Read the major out of any Node version spec this repo may write.
 *
 * Accepts a bare major (`22`), a full version (`22.14.0`), an optional `v`
 * prefix, and a patch wildcard (`22.x`, `22.14.x`). The wildcard is a pin, not
 * an alias: it names major 22 as firmly as `22` does, and a moving minor never
 * moves the ABI. It is also the idiomatic `setup-node` spelling, so rejecting
 * it would fail a contributor for writing the conventional thing.
 *
 * Rejects specs whose MAJOR moves — `lts/*`, `latest`, `node`, `current`.
 * Those resolve differently over time and per machine, which is the drift this
 * file exists to prevent, not a way to express a pin.
 *
 * @param {string} value
 * @returns {{ major: number } | { error: string }}
 */
export function parseNodeMajor(value) {
  const trimmed = String(value ?? "").trim();
  if (!trimmed) return { error: "no version given" };

  const match = /^v?(\d+)(?:\.(?:\d+|x)){0,2}$/.exec(trimmed);
  if (!match) {
    return {
      error: `${JSON.stringify(trimmed)} does not name a fixed major. Aliases like "lts/*" resolve differently over time and per machine.`,
    };
  }
  return { major: Number(match[1]) };
}

/**
 * Read the major version out of an `.nvmrc`.
 *
 * A thin wrapper over {@link parseNodeMajor} that words its failures for the
 * file, since that is the one place a human is told to edit by name.
 *
 * @param {string} content
 * @returns {{ major: number } | { error: string }}
 */
export function parseNvmrc(content) {
  const trimmed = String(content ?? "").trim();
  if (!trimmed) return { error: ".nvmrc is empty" };

  const parsed = parseNodeMajor(trimmed);
  if ("error" in parsed) {
    return {
      error: `.nvmrc must hold a version, not an alias — found ${JSON.stringify(trimmed)}. Aliases like "lts/*" resolve differently over time and per machine.`,
    };
  }
  return parsed;
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
 * matrix reference (`${{ matrix.node }}`) is returned whole so the caller can
 * reject it rather than silently skip it — and so the rejection quotes a
 * string that actually appears in the file.
 *
 * @param {string} yamlText
 * @returns {string[]}
 */
export function extractWorkflowNodeVersions(yamlText) {
  const versions = [];
  const pattern =
    /^[ \t]*node-version:[ \t]*(?:["']([^"']*)["']|(\$\{\{[^}]*\}\})|([^\s#]+))/gm;
  let match;
  while ((match = pattern.exec(String(yamlText ?? ""))) !== null) {
    versions.push((match[1] ?? match[2] ?? match[3] ?? "").trim());
  }
  return versions;
}

/**
 * Pull every `node-version-file:` path out of a workflow file's text.
 *
 * A workflow that reads `.nvmrc` cannot drift from it — it IS the pin, and is
 * the better way to write this. The guard has to see those declarations for
 * two reasons: so it does not demand a literal `node-version:` that would fail
 * the strictly better config, and so its vacuous-pass check still has
 * something to count if every workflow adopts the file form.
 *
 * @param {string} yamlText
 * @returns {string[]}
 */
export function extractWorkflowNodeVersionFiles(yamlText) {
  const files = [];
  const pattern =
    /^[ \t]*node-version-file:[ \t]*(?:["']([^"']*)["']|([^\s#]+))/gm;
  let match;
  while ((match = pattern.exec(String(yamlText ?? ""))) !== null) {
    files.push((match[1] ?? match[2] ?? "").trim());
  }
  return files;
}

/**
 * Pull every Node version a Dockerfile's `FROM` lines name.
 *
 * Only `FROM` lines count: the Dockerfiles here explain their base image in a
 * comment right above it (`# Pull node:22-slim via …`), so a text search for
 * `node:` would read prose as a pin and a stale comment as drift.
 *
 * Handles the registry prefix these files use (`mirror.gcr.io/library/node:…`)
 * and `--platform=` flags, skips stage references (`FROM base AS build`) and
 * non-node images, and strips the variant suffix so `node:22.14.0-bookworm`
 * reports `22.14.0`. A floating tag (`node:lts-slim`) is returned as `lts` for
 * the caller to reject, since its major moves.
 *
 * @param {string} dockerfileText
 * @returns {string[]}
 */
export function extractDockerfileNodeVersions(dockerfileText) {
  const versions = [];
  const pattern = /^[ \t]*FROM[ \t]+(?:--\S+[ \t]+)*(\S+)/gim;
  let match;
  while ((match = pattern.exec(String(dockerfileText ?? ""))) !== null) {
    const tag = /(?:^|\/)node:(\S+)$/.exec(match[1]);
    if (!tag) continue;
    versions.push(tag[1].split("-")[0]);
  }
  return versions;
}

/**
 * Check one file's declared versions against the pinned major.
 *
 * @param {{ file: string, versions: string[] }} declared
 * @param {number} major
 * @param {string} what how the file states a version, for the message
 * @returns {string[]}
 */
function checkDeclaredVersions({ file, versions }, major, what) {
  const errors = [];
  for (const version of versions) {
    const parsed = parseNodeMajor(version);
    if ("error" in parsed) {
      errors.push(
        `${file} sets ${what} ${JSON.stringify(version)}, which does not name a fixed major. It must run the same Node the pin names (${major}).`,
      );
      continue;
    }
    if (parsed.major !== major) {
      errors.push(
        `${file} sets ${what} ${version} but .nvmrc says ${major}. Bump both, or the places that run Node stop agreeing about which one.`,
      );
    }
  }
  return errors;
}

/**
 * @param {object} input
 * @param {string | null} input.nvmrc raw `.nvmrc` contents, or null if absent
 * @param {string | undefined} input.enginesNode root package.json `engines.node`
 * @param {Array<{ file: string, versions: string[], versionFiles?: string[] }>} input.workflows
 * @param {Array<{ file: string, versions: string[] }>} [input.dockerfiles]
 * @returns {string[]} one message per problem; empty means the pin is coherent
 */
export function validateNodeVersionPin({
  nvmrc,
  enginesNode,
  workflows,
  dockerfiles = [],
}) {
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

  for (const workflow of workflows) {
    errors.push(...checkDeclaredVersions(workflow, major, "node-version:"));

    for (const versionFile of workflow.versionFiles ?? []) {
      // Reading the root pin is the best case and needs no comparison. Reading
      // some OTHER file is a second pin that can drift from this one.
      if (versionFile.replace(/^\.\//, "") === ".nvmrc") continue;
      errors.push(
        `${workflow.file} sets node-version-file: ${JSON.stringify(versionFile)}, which is a second pin that can drift. Point it at the root .nvmrc.`,
      );
    }
  }

  for (const dockerfile of dockerfiles) {
    errors.push(...checkDeclaredVersions(dockerfile, major, "FROM node:"));
  }

  return errors;
}
