/**
 * Enumerating a repo the way a guard should: by asking git, not readdir.
 *
 * A guard that asserts something about "the repo" and reads the working
 * directory instead will eventually assert something about a developer's
 * private files. `dev-stack-port-isolation`'s band check did exactly that — it
 * globbed `docker-compose*.yml` out of readdirSync and failed on a gitignored
 * `docker-compose.local.yml`, telling the developer to fix it by committing
 * their local port into the shared RESERVED_PORTS list. An assertion nobody can
 * discharge correctly is one people learn to look past, and it was red only
 * locally — never in CI, where the file does not exist.
 *
 * Four guards here already reach for git rather than readdir for the same
 * reason: `node-version-pin.test.mjs`, `docs-required.test.mjs`,
 * `curl-origin-csrf.test.mjs` and `format-gate.test.mjs`. They are deliberately
 * NOT rewritten to call this — each wants a different slice (every Dockerfile
 * at any depth, every shell script, the full path list), and this helper answers
 * one narrow question. Sharing the `execFileSync` line would not have shared
 * anything worth sharing.
 */

import { execFileSync } from "node:child_process";

/**
 * Node's default is 1 MB. The repo's own listing is already ~115 KB and grows,
 * and overflowing it throws ENOBUFS, which this module turns into `null` — a
 * silent fall back to the readdir behaviour the module exists to replace.
 * `docs-required.test.mjs` sets an explicit ceiling for the same reason.
 */
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/**
 * The files git tracks directly in `dir`, excluding anything below it.
 *
 * "Tracked" means "in the index", which is what `git ls-files` reports: a new
 * file counts once it is `git add`ed and not before. Paths come back relative
 * to `dir`, so passing a subdirectory enumerates that subdirectory — and the
 * recursion is filtered out here, since `git ls-files` itself lists every
 * depth.
 *
 * Returns `null` — never `[]` — when git cannot answer, so the caller can fall
 * back to reading the directory. The direction is deliberate: a guard may check
 * too much, never too little, and an empty corpus is the one failure that turns
 * a check green forever without anyone noticing.
 *
 * @param {string} dir absolute path to a repository, worktree, or subdirectory
 * @returns {string[] | null}
 */
export function trackedFilesIn(dir) {
  let output;
  try {
    output = execFileSync("git", ["ls-files", "-z"], {
      cwd: dir,
      encoding: "utf8",
      maxBuffer: MAX_OUTPUT_BYTES,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch {
    return null;
  }
  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.includes("/"));
}
