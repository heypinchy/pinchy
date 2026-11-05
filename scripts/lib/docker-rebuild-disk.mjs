import { posix } from "node:path";
import { parse } from "yaml";

// Disk guard for jobs that build a Pinchy image while another one already sits
// on the runner's disk.
//
// docker-smoke pulls the pre-built Pinchy and OpenClaw images, tests them,
// tears the stack down (containers and volumes, never images) and then runs
// the dev stack with `up --build`, which builds both images again from
// scratch. Holding the pulled copies and a fresh BuildKit tree at once ran the
// runner out of disk in the OpenClaw build (CI run 42014766282; #1256, #1279
// and #1285 lost runs the same way). Nothing in the workflow looked wrong:
// each step is fine alone, and the failure is the sum.
//
// The rule: once a job holds a Pinchy image — it pulled the CI images, pulled
// one by name, or built one into the local image store — a later step that
// builds one must be preceded by the reclaim-docker-disk action.
//
// What counts as a Pinchy build:
// - `docker build` / `docker buildx build`: every Dockerfile this repo builds
//   that way is a root Dockerfile, so all of them count.
// - `docker compose … --build` / `docker compose … build`: only if one of the
//   `-f` files gives a service a `build:` whose context is the repo root. The
//   mocks build from their own directories and are a few MB; counting them
//   would flag screenshots.yml's fake-ollama. A `-f` that is not a literal
//   path (`$COMPOSE_FILES`) cannot be read, so it counts — unreadable input
//   fails loud rather than passing.
// - `docker/build-push-action`: a build, but it holds an image in the local
//   store only with `load: true`; a pushed image never lands there.
//
// Two steps whose `if:` pin `needs.build-image.result` to different values
// never both run (the pull on a same-repo PR, the local build on a fork PR),
// so they do not count against each other.
//
// The workflow is read with a real YAML parser; only `uses:`, `with.load`,
// `if:` and `run:` are inspected. A `run:` is matched as text, which can
// over-report (a build command inside an `echo`) but not miss a plain one.
// Builds inside ONE step are not compared with each other: the fork-PR
// fallbacks build Pinchy and OpenClaw back to back, two different images,
// which is not the doubled-image shape this guard is about.

export const RECLAIM_ACTION = "./.github/actions/reclaim-docker-disk";
const PULL_CI_IMAGES = "./.github/actions/pull-ci-images";

// `posix.normalize` drops the leading `./`, so compare normalized forms.
const normalizeAction = (uses) => posix.normalize(uses).replace(/\/$/, "");
const RECLAIM_PATH = normalizeAction(RECLAIM_ACTION);
const PULL_CI_IMAGES_PATH = normalizeAction(PULL_CI_IMAGES);

function localAction(step) {
  if (typeof step.uses !== "string") return null;
  const uses = step.uses.trim();
  if (!uses.startsWith("./")) return null;
  return normalizeAction(uses);
}

function isBuildPushAction(step) {
  return (
    typeof step.uses === "string" &&
    step.uses.trim().startsWith("docker/build-push-action@")
  );
}

/** Shell commands in a `run:`, one per line, `\` continuations joined. */
function commands(step) {
  if (typeof step.run !== "string") return [];
  return step.run
    .replace(/\\\r?\n\s*/g, " ")
    .split(/\r?\n|&&|;/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

const DOCKER_BUILD = /\bdocker\s+(?:buildx\s+)?build\b/;
const COMPOSE = /\bdocker\s+compose\b/;
const COMPOSE_BUILD = /\s(?:--build\b|build\b)/;
const PULL = /\bdocker\s+pull\b|\bdocker\s+compose\b.*\spull\b/;

/** The `-f`/`--file` arguments of a compose command, as written. */
export function composeFiles(command) {
  const files = [];
  const re = /(?:^|\s)(?:-f|--file)(?:\s+|=)("[^"]*"|'[^']*'|\S+)/g;
  for (const m of command.matchAll(re))
    files.push(m[1].replace(/^["']|["']$/g, ""));
  if (files.length > 0) return files;
  // No -f: the default file — unless the files arrive through a variable
  // (`docker compose $COMPOSE_FILES up`), which cannot be read here.
  return command.includes("$") ? ["$unresolved"] : ["docker-compose.yml"];
}

/**
 * True if any service in the compose files builds from the repo root.
 * `readFile(path)` returns the file's text, or null if it does not exist.
 */
export function composeBuildsRootImage(files, readFile) {
  for (const file of files) {
    if (file.includes("$")) return true; // cannot resolve — count it
    const text = readFile(file);
    if (text === null) throw new Error(`compose file ${file} does not exist`);
    // Compose's own merge tags (`!override`, `!reset`) are not YAML core
    // tags; the values under them parse fine, so only the warning is muted.
    const services = parse(text, { logLevel: "error" })?.services ?? {};
    for (const service of Object.values(services)) {
      const build = service?.build;
      if (build === undefined || build === null) continue;
      const context =
        typeof build === "string" ? build : (build.context ?? ".");
      if (posix.normalize(String(context)).replace(/\/$/, "") === ".")
        return true;
    }
  }
  return false;
}

/** True if the step builds a Pinchy image. */
export function isBuildStep(step, readFile) {
  if (isBuildPushAction(step)) return true;
  return commands(step).some(
    (cmd) =>
      DOCKER_BUILD.test(cmd) ||
      (COMPOSE.test(cmd) &&
        COMPOSE_BUILD.test(cmd) &&
        composeBuildsRootImage(composeFiles(cmd), readFile)),
  );
}

/** True if the step leaves a Pinchy image in the local image store. */
export function holdsImageAfter(step, readFile) {
  if (localAction(step) === PULL_CI_IMAGES_PATH) return true;
  if (isBuildPushAction(step)) return step.with?.load === true;
  if (isBuildStep(step, readFile)) return true;
  return commands(step).some((cmd) => PULL.test(cmd));
}

/**
 * The value an `if:` pins `needs.build-image.result` to, or null when it pins
 * none or is not a plain conjunction (an `||` could let both steps run).
 */
export function pinnedBuildImageResult(step) {
  if (typeof step.if !== "string") return null;
  if (step.if.includes("||")) return null;
  const matches = [
    ...step.if.matchAll(/needs\.build-image\.result\s*==\s*'([a-z]+)'/g),
  ];
  return matches.length === 1 ? matches[0][1] : null;
}

function exclusive(a, b) {
  const pa = pinnedBuildImageResult(a);
  const pb = pinnedBuildImageResult(b);
  return pa !== null && pb !== null && pa !== pb;
}

function parseWorkflow(file, text) {
  try {
    return parse(text);
  } catch (err) {
    throw new Error(`${file}: YAML does not parse: ${err.message}`);
  }
}

function stepsByJob(doc) {
  const jobs = doc?.jobs && typeof doc.jobs === "object" ? doc.jobs : {};
  return Object.entries(jobs).map(([name, job]) => [
    name,
    (Array.isArray(job?.steps) ? job.steps : []).filter(
      (s) => s && typeof s === "object",
    ),
  ]);
}

/**
 * Every build step in the file that runs while a Pinchy image an earlier step
 * left behind is still on disk. Throws, naming the file, if the YAML does not
 * parse.
 */
export function rebuildDiskProblems(file, text, readFile) {
  const problems = [];
  for (const [name, steps] of stepsByJob(parseWorkflow(file, text))) {
    let holders = []; // steps that left an image behind since the last reclaim
    steps.forEach((step, index) => {
      if (localAction(step) === RECLAIM_PATH) {
        holders = [];
        return;
      }
      if (isBuildStep(step, readFile)) {
        const live = holders.find((h) => !exclusive(h.step, step));
        if (live)
          problems.push(
            `${file}:${name} step ${index + 1} (${label(step)}) builds a Pinchy image while step ${live.index + 1} (${label(live.step)}) left one on disk — add \`- uses: ${RECLAIM_ACTION}\` before the build`,
          );
      }
      if (holdsImageAfter(step, readFile)) holders.push({ step, index });
    });
  }
  return problems;
}

/** Names of the jobs that build a Pinchy image, for the corpus check. */
export function jobsWithBuilds(file, text, readFile) {
  return stepsByJob(parseWorkflow(file, text))
    .filter(([, steps]) => steps.some((s) => isBuildStep(s, readFile)))
    .map(([name]) => name);
}

function label(step) {
  if (typeof step.name === "string") return step.name;
  if (typeof step.uses === "string") return step.uses;
  return "unnamed step";
}
