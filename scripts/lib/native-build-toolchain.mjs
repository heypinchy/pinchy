/**
 * Drift guard: a stage that installs something compilable can compile it.
 *
 * `better-sqlite3` is in root `pnpm.onlyBuiltDependencies`, and its install
 * script is one line:
 *
 *   prebuild-install || node-gyp rebuild --release
 *
 * The left half downloads a prebuilt binary; the right half compiles one when
 * that download is unusable. The right half is not a nicety — it is the ONLY
 * thing standing between a transient network hiccup and a failed build. And it
 * cannot run at all without python3, a C++ compiler and make.
 *
 * `Dockerfile.pinchy.dev` had none of them, so on 2026-08-05 a `prebuild-install
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
 * `Dockerfile.openclaw` has installed the toolchain since its builder/runtime
 * split and documents exactly this reason — one of three files got it right,
 * which is the count at which hand-checking stops working (CI run 30994369292
 * on PR #1110).
 *
 * So the guarded property is: every Dockerfile stage that installs a manifest
 * containing a compile-at-install dependency has python3, a C++ compiler and
 * make — in that stage or in a stage it descends from.
 *
 * Three decisions are load-bearing:
 *
 *   - **Ancestry.** Dockerfile.pinchy installs the toolchain in `base` and runs
 *     its two installs in `prod-deps` and `build`. A check that read only the
 *     installing stage would call that correct file broken, and the obvious way
 *     to silence it — duplicating the apt line into `runtime` — ships 306 MB
 *     nothing needs.
 *   - **The manifest decides, not the package manager.** An earlier draft
 *     matched `pnpm install` only, on the theory that the `npm install` lines
 *     belong to mock images with tiny pure-JS manifests. That is true of
 *     `config/*-mock`, and false of the file this guard was written about:
 *     `Dockerfile.openclaw` installs `packages/plugins/pinchy-files/package.json`
 *     — which depends on better-sqlite3 — with `npm install`, in a stage the
 *     guard then never looked at. So an install site is classified by resolving
 *     the manifest it installs (through the COPY that put it there) and asking
 *     whether it declares anything in `onlyBuiltDependencies`. The mocks stay
 *     exempt because their manifests say express/imapflow/nodemailer/tsx, which
 *     is a fact this guard reads rather than a claim someone wrote down.
 *   - **An install whose manifest cannot be resolved counts as compilable.**
 *     That is the safe direction: `npm install -g <anything>` may compile, and
 *     a stage that genuinely installs nothing native can say so by having a
 *     manifest this guard can find.
 *
 * Known limitations, stated rather than papered over:
 *
 *   - It reads a manifest's DECLARED dependencies, never the resolved tree. A
 *     pure-JS package that pulls a native one transitively is invisible to it.
 *     Resolving that needs a lockfile the mock images do not have.
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

import { posix } from "node:path";

/** Package managers whose install may run a compile-at-install script. */
const INSTALL_VERBS = {
  pnpm: new Set(["install", "i", "add"]),
  npm: new Set(["install", "i", "ci", "add"]),
  yarn: new Set(["install", "add"]),
};

/**
 * What node-gyp needs to run at all — all three, not any of them.
 *
 * `build-essential` is the one package that supplies the whole set. Bare `gcc`
 * is NOT a C++ compiler on Debian (node-gyp dies on `make: c++: No such file or
 * directory` one message later), and `g++` without `make` dies on `make` — both
 * are the same dead end the missing python3 was, reached a step further along.
 */
const PYTHON = /(?:^|\s)python3(?:\s|$|=)/;
const CXX = /(?:^|\s)(?:build-essential|g\+\+|clang\+\+)(?:\s|$|=)/;
const MAKE = /(?:^|\s)(?:build-essential|make)(?:\s|$|=)/;

const PACKAGE_INSTALL =
  /apt-get\s+install|apt\s+install|apk\s+add|dnf\s+install|yum\s+install/;

/**
 * Split a Dockerfile into stages, joining line continuations and tracking the
 * working directory each instruction runs in.
 *
 * Text rather than a parser dependency: the guard has to run under
 * `node --test` with nothing installed. Two details are not cosmetic:
 *
 *   - **Comment lines are dropped whole, including inside a continuation.**
 *     Docker strips them there; a checker that appends an empty string instead
 *     ends the statement early and loses everything after the comment. That is
 *     not theoretical — writing the toolchain apt line with a comment between
 *     its `\` continuations made the packages invisible to the first draft.
 *   - **A comment never becomes a fact.** These Dockerfiles explain their apt
 *     lines in prose directly above them (Dockerfile.openclaw has one naming
 *     `build-essential` three lines above the real thing), so a text search
 *     would read the explanation of a DELETED install as the install. Same rule
 *     the node-version pin follows for `FROM node:`.
 *
 * @param {string} dockerfileText
 * @returns {Array<{
 *   name: string | null,
 *   parent: string | null,
 *   index: number,
 *   workdir: string,
 *   runs: Array<{ command: string, workdir: string }>,
 *   copies: Array<{ src: string, dest: string, workdir: string }>,
 * }>}
 */
export function parseDockerfileStages(dockerfileText) {
  const stages = [];
  const lines = String(dockerfileText ?? "").split("\n");

  let pending = "";
  for (const raw of lines) {
    if (/^\s*#/.test(raw) || !raw.trim()) continue;

    pending = pending ? `${pending} ${raw.trim()}` : raw.trim();
    if (/\\$/.test(pending)) {
      pending = pending.replace(/\\$/, "").trim();
      continue;
    }

    const statement = pending;
    pending = "";
    if (!statement) continue;

    const from = /^FROM\s+(?:--\S+\s+)*(\S+)(?:\s+AS\s+(\S+))?/i.exec(
      statement,
    );
    if (from) {
      const parent = from[1].toLowerCase();
      const inherited = stages.find(
        (stage) => stage.name !== null && stage.name === parent,
      );
      stages.push({
        name: from[2] ? from[2].toLowerCase() : null,
        parent,
        index: stages.length,
        workdir: inherited ? inherited.workdir : "/",
        runs: [],
        copies: [],
      });
      continue;
    }

    const stage = stages[stages.length - 1];
    if (!stage) continue;

    const workdir = /^WORKDIR\s+(\S+)/i.exec(statement);
    if (workdir) {
      stage.workdir = absolutize(workdir[1], stage.workdir);
      continue;
    }

    const run = /^RUN\s+(?:--\S+\s+)*(.*)$/i.exec(statement);
    if (run) {
      stage.runs.push({ command: run[1], workdir: stage.workdir });
      continue;
    }

    const copy = /^(?:COPY|ADD)\s+(.*)$/i.exec(statement);
    if (copy) {
      const args = copy[1]
        .split(/\s+/)
        .filter((token) => token && !token.startsWith("--"));
      if (args.length >= 2) {
        const dest = args[args.length - 1];
        for (const src of args.slice(0, -1)) {
          stage.copies.push({ src, dest, workdir: stage.workdir });
        }
      }
    }
  }

  return stages;
}

function absolutize(path, workdir) {
  return path.startsWith("/")
    ? posix.normalize(path)
    : posix.join(workdir, path);
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
    current = stages.find(
      (stage) => stage.name !== null && stage.name === current.parent,
    );
  }
  return chain;
}

/**
 * Does this stage — or an ancestor — install everything node-gyp needs?
 *
 * @param {ReturnType<typeof parseDockerfileStages>} chain
 * @returns {{ python: boolean, cxx: boolean, make: boolean }}
 */
export function toolchainInChain(chain) {
  const found = { python: false, cxx: false, make: false };
  for (const stage of chain) {
    for (const { command } of stage.runs) {
      if (!PACKAGE_INSTALL.test(command)) continue;
      if (PYTHON.test(command)) found.python = true;
      if (CXX.test(command)) found.cxx = true;
      if (MAKE.test(command)) found.make = true;
    }
  }
  return found;
}

/** Split a shell command into its simple commands, in order. */
function splitSimpleCommands(command) {
  return command
    .split(/&&|\|\||[;|]/)
    .map((part) => part.trim())
    .filter(Boolean);
}

/**
 * Every install this Dockerfile runs, with the directory it runs in.
 *
 * `cd /tmp/pinchy-files && npm install` is the shape Dockerfile.openclaw uses,
 * so the working directory has to follow a `cd` inside the same RUN — not just
 * the stage's WORKDIR.
 *
 * @param {ReturnType<typeof parseDockerfileStages>[number]} stage
 * @returns {Array<{ tool: string, dir: string, global: boolean, command: string }>}
 */
export function installsInStage(stage) {
  const sites = [];
  for (const { command, workdir } of stage.runs) {
    let dir = workdir;
    for (const simple of splitSimpleCommands(command)) {
      const tokens = simple.split(/\s+/).filter(Boolean);
      if (tokens[0] === "cd" && tokens[1]) {
        dir = absolutize(tokens[1], dir);
        continue;
      }
      const verbs = INSTALL_VERBS[tokens[0]];
      if (!verbs) continue;
      if (!tokens.slice(1).some((token) => verbs.has(token))) continue;
      sites.push({
        tool: tokens[0],
        dir,
        global: tokens.includes("-g") || tokens.includes("--global"),
        command: simple,
      });
    }
  }
  return sites;
}

/**
 * Where a COPY puts its source, as an absolute path in the image.
 *
 * `COPY package.json ./` under `WORKDIR /app` lands at `/app/package.json`;
 * `COPY packages/plugins/pinchy-files/package.json /tmp/pinchy-files/package.json`
 * lands where it says. Both shapes are in the tree, so both have to resolve.
 */
function copyTarget({ src, dest, workdir }) {
  const abs = absolutize(dest, workdir);
  const srcName = posix.basename(src);
  if (/[/.]$/.test(dest) || posix.basename(abs) !== srcName) {
    return posix.join(abs, srcName);
  }
  return abs;
}

/**
 * The repo-relative manifest an install site reads, or null if none is found.
 *
 * @param {ReturnType<typeof parseDockerfileStages>} chain
 * @param {{ dir: string }} site
 * @param {string} dockerfileDir directory of the Dockerfile, repo-relative
 * @param {(path: string) => object | null} readManifest
 */
function resolveManifest(chain, site, dockerfileDir, readManifest) {
  const wanted = posix.join(site.dir, "package.json");
  for (const stage of chain) {
    for (const copy of stage.copies) {
      if (copyTarget(copy) !== wanted) continue;
      // The build context is the Dockerfile's own directory for the mock
      // images and the repo root for the top-level ones. Try both rather than
      // hand-maintaining which is which — a wrong guess would silently
      // reclassify an install instead of failing.
      for (const candidate of [posix.join(dockerfileDir, copy.src), copy.src]) {
        const manifest = readManifest(posix.normalize(candidate));
        if (manifest) return { path: candidate, manifest };
      }
    }
  }
  return null;
}

/**
 * Classify every install site in every Dockerfile.
 *
 * @param {object} input
 * @param {Array<{ file: string, text: string, dir?: string }>} input.dockerfiles
 * @param {string[]} input.onlyBuiltDependencies root pnpm.onlyBuiltDependencies
 * @param {(path: string) => object | null} [input.readManifest] repo-relative
 *   manifest reader; returns null when the path does not exist
 */
export function analyzeDockerfiles({
  dockerfiles,
  onlyBuiltDependencies,
  readManifest = () => null,
}) {
  const compilable = new Set(onlyBuiltDependencies ?? []);
  const sites = [];

  for (const { file, text, dir } of dockerfiles) {
    const dockerfileDir = dir ?? posix.dirname(file);
    const stages = parseDockerfileStages(text);
    for (const stage of stages) {
      const chain = resolveStageChain(stages, stage.index);
      for (const site of installsInStage(stage)) {
        const record = {
          file,
          stage: stage.name,
          tool: site.tool,
          command: site.command,
          toolchain: toolchainInChain(chain),
        };

        if (site.tool === "pnpm") {
          // A pnpm install in this repo is always a workspace install, and the
          // workspace is exactly what onlyBuiltDependencies describes.
          sites.push({
            ...record,
            compiles: [...compilable],
            why: "workspace install",
          });
          continue;
        }

        if (site.global) {
          sites.push({
            ...record,
            compiles: ["unknown"],
            why: "global install — no manifest to read",
          });
          continue;
        }

        const resolved = resolveManifest(
          chain,
          site,
          dockerfileDir,
          readManifest,
        );
        if (!resolved) {
          sites.push({
            ...record,
            compiles: ["unknown"],
            why: `no manifest found for ${site.dir}`,
          });
          continue;
        }

        const declared = Object.keys({
          ...resolved.manifest.dependencies,
          ...resolved.manifest.optionalDependencies,
        });
        sites.push({
          ...record,
          compiles: declared.filter((name) => compilable.has(name)),
          why: resolved.path,
        });
      }
    }
  }

  return sites;
}

/**
 * @param {Parameters<typeof analyzeDockerfiles>[0]} input
 * @returns {string[]} one message per problem; empty means every install that
 *   can compile has something to compile with
 */
export function validateNativeBuildToolchain(input) {
  const { dockerfiles, onlyBuiltDependencies } = input;
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
    return [
      "Root package.json pnpm.onlyBuiltDependencies is empty, so nothing in this workspace is allowed to compile at install time. That is the premise this guard rests on — re-derive it (or delete the guard and the apt lines it demands) rather than leaving a check nobody can justify.",
    ];
  }

  const sites = analyzeDockerfiles(input);

  for (const site of sites) {
    if (site.compiles.length === 0) continue;
    const { python, cxx, make } = site.toolchain;
    if (python && cxx && make) continue;

    const missing = [
      python ? null : "python3",
      cxx ? null : "a C++ compiler",
      make ? null : "make",
    ].filter(Boolean);
    const where = site.stage ? `stage \`${site.stage}\`` : "its only stage";
    errors.push(
      `${site.file}: ${where} runs \`${site.command}\` without ${missing.join(" and ")}. ` +
        `That install compiles ${site.compiles.join(", ")} from source when the prebuilt download fails (${site.why}), so without the toolchain a network hiccup is a hard build failure instead of a slower build. Add to that stage (or a stage it descends from):\n` +
        "    RUN apt-get update && apt-get install -y --no-install-recommends \\\n" +
        "          python3 build-essential \\\n" +
        "        && rm -rf /var/lib/apt/lists/*",
    );
  }

  // A walker that finds nothing passes in silence, which is how a coverage
  // gate becomes decoration. Zero install sites means the parser stopped
  // reading Dockerfiles; zero COMPILABLE ones means the classifier stopped
  // recognising the workspace install that better-sqlite3 rides in on — and
  // that one is the quieter of the two, because every remaining site would be
  // waved through as pure JS.
  if (sites.length === 0) {
    errors.push(
      `No Dockerfile stage running an install was found across ${dockerfiles.length} file(s). Either the workspace stopped being installed in an image, or this guard stopped being able to read one — check the parser before trusting the clean verdict.`,
    );
  } else if (!sites.some((site) => site.compiles.length > 0)) {
    errors.push(
      `${sites.length} install site(s) were found and not one of them installs ${onlyBuiltDependencies.join(", ")}. The workspace install is meant to — check the classifier before trusting the clean verdict.`,
    );
  }

  return errors;
}
