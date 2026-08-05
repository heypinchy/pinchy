/**
 * Drift guard: a stage that installs this workspace can compile from source.
 *
 * `better-sqlite3` is in root `pnpm.onlyBuiltDependencies`, and its install
 * script is one line:
 *
 *   prebuild-install || node-gyp rebuild --release
 *
 * The left half downloads a prebuilt binary; the right half compiles one when
 * that download is unusable. The right half is not a nicety — it is the ONLY
 * thing standing between a transient network hiccup and a failed build. And it
 * cannot run at all without python3 and a C++ toolchain.
 *
 * `Dockerfile.pinchy.dev` had neither, so on 2026-08-05 a `prebuild-install
 * warn install Request timed out` in CI became:
 *
 *   gyp ERR! find Python - "" could not be run
 *   target pinchy: failed to solve: … "pnpm install --frozen-lockfile"
 *       did not complete successfully: exit code: 1
 *
 * Read the shape rather than the timeout: the fallback did not fail, it
 * structurally could not exist. A rerun heals that only for as long as the
 * next download happens to succeed, so the failure reads as flake and returns
 * on its own schedule. `Dockerfile.pinchy` (prod) carried the same gap;
 * `Dockerfile.openclaw` has installed the pair since its builder/runtime split
 * and documents exactly this reason — one of three files got it right, which
 * is the count at which hand-checking stops working (CI run 30994369292 on PR #1110).
 *
 * So the guarded property is: every Dockerfile stage that runs `pnpm install`
 * has python3 and a C++ compiler, in that stage or in a stage it descends
 * from. Ancestry is load-bearing — Dockerfile.pinchy installs the toolchain in
 * `base` and runs the two installs in `prod-deps` and `build`, and a check that
 * only read the installing stage would call that broken.
 *
 * Known limitations, stated rather than papered over:
 *
 *   - It sees `pnpm install`, which in this repo always means "install THIS
 *     workspace, whose lockfile contains better-sqlite3". The mock images run
 *     `npm install` against their own tiny manifests (express, imapflow,
 *     nodemailer — all pure JS), and the guard deliberately says nothing about
 *     them: it has no way to know what an arbitrary manifest resolves to, and
 *     demanding a 306 MB toolchain in seven mock images to protect a
 *     dependency they do not have would be worse than the gap it closes. A
 *     mock that grows a native dependency is review's job.
 *   - It checks that a toolchain is installed, never that it works. A build
 *     that finds python3 and still cannot compile is a different failure and
 *     says so out loud.
 *
 * Verify a change to this by reproduction, not by reading: force the source
 * path with `npm_config_build_from_source=true` before the install (that is
 * what a dead download looks like to the install script), build, and watch it
 * fail without the apt line and succeed with it.
 *
 * Read-side sibling of the node-version-pin / format-gate / plugin-typecheck
 * guards (see AGENTS.md).
 */

/** Package managers whose install compiles this workspace's native modules. */
const WORKSPACE_INSTALL = /(?:^|[\s;&|(])pnpm\s+(?:install|i|add)(?:\s|$)/;

/** What node-gyp needs to run at all. */
const PYTHON = /(?:^|\s)python3(?:\s|$|=)/;
const COMPILER = /(?:^|\s)(?:build-essential|g\+\+|gcc)(?:\s|$|=)/;

/**
 * Split a Dockerfile into stages, joining line continuations.
 *
 * Text rather than a parser dependency: the guard has to run under
 * `node --test` with nothing installed. Comments are dropped BEFORE the
 * continuation join, because these Dockerfiles explain their apt lines in prose
 * directly above them — a comment mentioning `build-essential` (Dockerfile.
 * openclaw has one, three lines above the real thing) must never read as the
 * package being installed. Same rule the node-version pin follows for
 * `FROM node:`: a stale comment is not a fact about the image.
 *
 * @param {string} dockerfileText
 * @returns {Array<{ name: string | null, parent: string | null, index: number, runs: string[] }>}
 */
export function parseDockerfileStages(dockerfileText) {
  const stages = [];
  const lines = String(dockerfileText ?? "").split("\n");

  let pending = "";
  for (const raw of lines) {
    const line = raw.replace(/^\s*#.*$/, "");
    if (!line.trim() && !pending) continue;

    if (pending) {
      pending += " " + line.trim();
    } else {
      pending = line.trim();
    }
    if (/\\$/.test(pending.trim())) {
      pending = pending.trim().replace(/\\$/, "");
      continue;
    }

    const statement = pending.trim();
    pending = "";
    if (!statement) continue;

    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(
      statement,
    );
    if (from) {
      stages.push({
        name: from[2] ? from[2].toLowerCase() : null,
        parent: from[1].toLowerCase(),
        index: stages.length,
        runs: [],
      });
      continue;
    }

    const run = /^RUN\s+(?:--\S+\s+)*(.*)$/i.exec(statement);
    if (run && stages.length > 0) {
      stages[stages.length - 1].runs.push(run[1]);
    }
  }

  return stages;
}

/**
 * Resolve a stage and every stage it descends from, nearest first.
 *
 * A `FROM base AS build` inherits everything `base` installed. Walking that
 * chain is what lets Dockerfile.pinchy put the toolchain in one place and run
 * two installs downstream of it. Guards against a cycle rather than trusting
 * the file, so a malformed Dockerfile fails as a message instead of a hang.
 *
 * @param {ReturnType<typeof parseDockerfileStages>} stages
 * @param {number} index
 * @returns {ReturnType<typeof parseDockerfileStages>}
 */
export function resolveStageChain(stages, index) {
  const chain = [];
  const seen = new Set();
  let current = stages[index];
  while (current && !seen.has(current.index)) {
    seen.add(current.index);
    chain.push(current);
    const parent = stages.find(
      (stage) => stage.name !== null && stage.name === current.parent,
    );
    current = parent;
  }
  return chain;
}

/**
 * Does this stage — or an ancestor — install python3 AND a C++ compiler?
 *
 * Both halves are required. python3 alone gets node-gyp past `find Python` and
 * into a `make: c++: No such file or directory`, which is the same dead end one
 * error message later.
 *
 * @param {ReturnType<typeof parseDockerfileStages>} chain
 * @returns {{ python: boolean, compiler: boolean }}
 */
export function toolchainInChain(chain) {
  let python = false;
  let compiler = false;
  for (const stage of chain) {
    for (const run of stage.runs) {
      if (
        !/apt-get\s+install|apk\s+add|dnf\s+install|yum\s+install/.test(run)
      ) {
        continue;
      }
      if (PYTHON.test(run)) python = true;
      if (COMPILER.test(run)) compiler = true;
    }
  }
  return { python, compiler };
}

/**
 * @param {object} input
 * @param {Array<{ file: string, text: string }>} input.dockerfiles
 * @param {string[]} input.onlyBuiltDependencies root pnpm.onlyBuiltDependencies
 * @returns {string[]} one message per problem; empty means every install stage
 *   can fall back to compiling
 */
export function validateNativeBuildToolchain({
  dockerfiles,
  onlyBuiltDependencies,
}) {
  const errors = [];

  // The premise, checked rather than assumed. This guard demands a toolchain
  // because one dependency is allowed to run a build script that compiles.
  // If that list empties, the demand is no longer justified by anything and
  // the honest move is to say so — not to keep asking for 306 MB of apt out of
  // habit. A verdict must not outlive its evidence.
  if (
    !Array.isArray(onlyBuiltDependencies) ||
    onlyBuiltDependencies.length === 0
  ) {
    errors.push(
      "Root package.json pnpm.onlyBuiltDependencies is empty, so nothing in this workspace is allowed to compile at install time. That is the premise this guard rests on — re-derive it (or delete the guard and the apt lines it demands) rather than leaving a check nobody can justify.",
    );
    return errors;
  }

  let installStages = 0;

  for (const { file, text } of dockerfiles) {
    const stages = parseDockerfileStages(text);
    for (const stage of stages) {
      if (!stage.runs.some((run) => WORKSPACE_INSTALL.test(run))) continue;
      installStages += 1;

      const chain = resolveStageChain(stages, stage.index);
      const { python, compiler } = toolchainInChain(chain);
      if (python && compiler) continue;

      const missing = [
        python ? null : "python3",
        compiler ? null : "build-essential",
      ].filter(Boolean);
      const where = stage.name ? `stage \`${stage.name}\`` : "its only stage";
      errors.push(
        `${file}: ${where} runs \`pnpm install\` without ${missing.join(" and ")}. ` +
          `${onlyBuiltDependencies.join(", ")} compile${onlyBuiltDependencies.length === 1 ? "s" : ""} from source when the prebuilt download fails, so without the toolchain a network hiccup is a hard build failure instead of a slower build. Add to that stage (or a stage it descends from):\n` +
          "    RUN apt-get update && apt-get install -y --no-install-recommends \\\n" +
          "          python3 build-essential \\\n" +
          "        && rm -rf /var/lib/apt/lists/*",
      );
    }
  }

  // A walker that finds nothing passes in silence, which is how a coverage
  // gate becomes decoration. Two files here run a workspace install across
  // three stages; zero means the parser stopped reading Dockerfiles, not that
  // the repo stopped installing.
  if (installStages === 0) {
    errors.push(
      `No Dockerfile stage running \`pnpm install\` was found across ${dockerfiles.length} file(s). Either the workspace stopped being installed in an image, or this guard stopped being able to read one — check the parser before trusting the clean verdict.`,
    );
  }

  return errors;
}
