import { posix } from "node:path";
import { parse, parseDocument, visit } from "yaml";

// Ordering guard for the docker-mirror action. A docker.io fallback inside
// the action can only use the authenticated pull limit if the job has already
// logged in to Docker Hub. Credentials live in the client's
// ~/.docker/config.json, so the action's daemon restart does not discard them.
//
// The workflows are read with a real YAML parser, not regexes. Every regex
// version of this guard missed a shape someone could plausibly write — a
// column-0 comment inside `jobs:`, a 4-space indent, a quoted key or path, a
// flow-style step — and each miss was silent: the job simply dropped out of
// the check. As a second line of defence, `mirrorReferenceMismatch` compares
// the parser's count of mirror steps against every scalar in the YAML AST
// that names docker-mirror, so a shape the parser does not model fails
// loudly instead of disappearing. The count reads the AST, not lines of
// text: comments are not scalars, so they drop out by construction, and a
// `#` inside a quoted string no longer hides what follows it.
//
// Composite actions are a second way around the guard: a composite under
// .github/actions/ that uses docker-mirror would put the mirror step one
// level below the workflow, where this check does not look.
// `compositeMirrorProblems` fails on any such reference rather than
// following it, because following it means deciding where the wrapper's
// login has to sit — a guard extension, not a parsing detail.
//
// Only `docker/login-action` counts as a Docker Hub login. A CLI
// `docker login` in a `run:` script is deliberately NOT recognised: telling
// `docker login -u me --password-stdin` (Docker Hub) from
// `docker login "$REGISTRY"` (GHCR) or from `echo "skipping docker login"`
// means parsing shell, which is the same trap one level down. A job that logs
// in only via the CLI must switch to the action or be listed as anonymous by
// design — both are one-line, unambiguous fixes.

export const MIRROR_ACTION = "./.github/actions/docker-mirror";

const DOCKER_HUB_REGISTRIES = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
]);

/**
 * A step that unconditionally logs in to Docker Hub: `docker/login-action`
 * with no `registry` or a Docker Hub host, and no `if:`. A conditional login
 * may not run, so it cannot be relied on to precede the mirror's fallback.
 */
function isDockerHubLogin(step) {
  if (typeof step.uses !== "string") return false;
  if (!step.uses.trim().startsWith("docker/login-action@")) return false;
  if (Object.hasOwn(step, "if")) return false;
  const registry = step.with?.registry;
  if (registry === undefined || registry === null) return true;
  return (
    typeof registry === "string" &&
    DOCKER_HUB_REGISTRIES.has(registry.trim().toLowerCase())
  );
}

const MIRROR_PATH = posix.normalize(MIRROR_ACTION);

/**
 * A step that uses the docker-mirror action, however its local path is
 * spelled: `./.github/actions/docker-mirror/` and
 * `./.github/actions/../actions/docker-mirror` both resolve to it. Only `./`
 * paths count — that is how GitHub recognises a local action.
 */
function isMirrorStep(step) {
  if (typeof step.uses !== "string") return false;
  const uses = step.uses.trim();
  if (!uses.startsWith("./")) return false;
  return posix.normalize(uses).replace(/\/$/, "") === MIRROR_PATH;
}

/**
 * Parses one workflow file. Returns every job with at least one mirror step,
 * as `{ file, name, mirror, login, mirrorSteps }` where `mirror` and `login`
 * are 1-based step numbers of the first mirror step and the first Docker Hub
 * login (-1 if none), and `mirrorSteps` counts all mirror steps in the job.
 * Throws, naming the file, if the YAML does not parse.
 */
export function parseMirrorJobs(file, text) {
  let doc;
  try {
    doc = parse(text);
  } catch (err) {
    throw new Error(`${file}: YAML does not parse: ${err.message}`);
  }
  const jobs = doc?.jobs;
  if (!jobs || typeof jobs !== "object") return [];
  const result = [];
  for (const [name, job] of Object.entries(jobs)) {
    const steps = Array.isArray(job?.steps) ? job.steps : [];
    const entry = { file, name, mirror: -1, login: -1, mirrorSteps: 0 };
    steps.forEach((step, index) => {
      if (!step || typeof step !== "object") return;
      if (isMirrorStep(step)) {
        entry.mirrorSteps++;
        if (entry.mirror === -1) entry.mirror = index + 1;
      }
      if (entry.login === -1 && isDockerHubLogin(step)) entry.login = index + 1;
    });
    if (entry.mirrorSteps > 0) result.push(entry);
  }
  return result;
}

const MIRROR_NAME = "docker-mirror";

/**
 * Scalars in the YAML AST that name docker-mirror — keys and values alike.
 * An alias counts as whatever it resolves to, so a step reused through
 * `*mirror` is counted here exactly as the parser's resolved copy is counted
 * as a step. Throws, naming the file, if the YAML does not parse.
 */
export function countMirrorReferences(text, file = "<input>") {
  const doc = parseDocument(text);
  if (doc.errors.length > 0)
    throw new Error(`${file}: YAML does not parse: ${doc.errors[0].message}`);
  return countIn(doc, doc.contents, new Set());
}

function countIn(doc, node, resolving) {
  let count = 0;
  visit(node, {
    Scalar(_key, scalar) {
      if (
        typeof scalar.value === "string" &&
        scalar.value.includes(MIRROR_NAME)
      )
        count++;
    },
    Alias(_key, alias) {
      const target = alias.resolve(doc);
      if (!target || resolving.has(target)) return;
      resolving.add(target);
      count += countIn(doc, target, resolving);
      resolving.delete(target);
    },
  });
  return count;
}

/**
 * A problem string if the parser found fewer (or more) mirror steps in a file
 * than the YAML names docker-mirror, else null. This is what keeps a shape
 * the parser does not model from silently leaving the check.
 */
export function mirrorReferenceMismatch(file, text, jobs) {
  const raw = countMirrorReferences(text, file);
  const parsed = jobs.reduce((sum, job) => sum + job.mirrorSteps, 0);
  if (raw === parsed) return null;
  return `${file} mentions ${MIRROR_NAME} ${raw} time(s) outside comments, but ${parsed} step(s) use ${MIRROR_ACTION} — the guard cannot read the rest`;
}

/**
 * Problems for composite actions (`{ file, text }`, `file` relative to the
 * repo root) that reference docker-mirror, other than docker-mirror itself.
 */
export function compositeMirrorProblems(actions) {
  const problems = [];
  for (const { file, text } of actions) {
    if (posix.basename(posix.dirname(file)) === MIRROR_NAME) continue;
    const count = countMirrorReferences(text, file);
    if (count > 0)
      problems.push(
        `${file} references ${MIRROR_NAME} ${count} time(s) — a composite action that wraps it takes its mirror step out of the login-order guard; extend docker-mirror-guard.mjs to follow the wrapper before using it`,
      );
  }
  return problems;
}

/** Problems with the login order, and stale anonymous-by-design entries. */
export function mirrorLoginProblems(jobs, anonymousByDesign) {
  const problems = [];
  for (const job of jobs) {
    const key = `${job.file}:${job.name}`;
    if (anonymousByDesign.has(key)) {
      if (job.login !== -1)
        problems.push(
          `${key} is listed as anonymous but logs in to Docker Hub`,
        );
      continue;
    }
    if (job.login === -1) {
      problems.push(
        `${key} uses docker-mirror (step ${job.mirror}) but has no unconditional docker/login-action step for Docker Hub — add one before the action, or list the job in ANONYMOUS_BY_DESIGN`,
      );
    } else if (job.login > job.mirror) {
      problems.push(
        `${key} logs in to Docker Hub (step ${job.login}) after docker-mirror (step ${job.mirror})`,
      );
    }
  }
  const seen = new Set(jobs.map((job) => `${job.file}:${job.name}`));
  for (const key of anonymousByDesign) {
    if (!seen.has(key))
      problems.push(
        `ANONYMOUS_BY_DESIGN lists ${key}, which no longer uses docker-mirror`,
      );
  }
  return problems;
}
