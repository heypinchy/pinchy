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
 * Several guards here already enumerate this way (node-version-pin, docs-required,
 * curl-origin-csrf, format-gate). This is that call in one place.
 */

import { execFileSync } from "node:child_process";

const defaultRun = (root) =>
  execFileSync("git", ["ls-files", "-z"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

/**
 * The files git tracks directly in `root`, excluding anything in a
 * subdirectory. `git ls-files` lists recursively, so that filtering is ours.
 *
 * Returns `null` — never `[]` — when git cannot answer, so the caller can fall
 * back to reading the directory. The direction is deliberate: a guard may check
 * too much, never too little, and an empty corpus is the one failure that turns
 * a check green forever without anyone noticing.
 *
 * @param {string} root absolute path to the repository (or worktree) root
 * @param {(root: string) => string} [run] injected for testing
 * @returns {string[] | null}
 */
export function trackedRootFiles(root, run = defaultRun) {
  let output;
  try {
    output = run(root);
  } catch {
    return null;
  }
  return output
    .split("\0")
    .filter(Boolean)
    .filter((file) => !file.includes("/"));
}
