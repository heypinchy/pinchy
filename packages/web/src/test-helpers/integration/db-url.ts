// The ONE place the integration suite's Postgres URL is decided.
//
// It is imported by both halves of `pnpm test:db`:
//
//   - `vitest.integration.config.ts`, which puts the URL in the workers' env so
//     tests connect to it, and
//   - `global-setup.ts`, which DROPs and CREATEs that database and migrates it.
//
// They used to resolve it separately, and the second one carried a hard-coded
// `localhost:5434`. In any worktree that had run `pnpm worktree:env` the two
// then addressed DIFFERENT servers — tests on the allocated port, DROP DATABASE
// on 5434. With nothing bound there that is a loud ECONNREFUSED; with another
// worktree's dev stack bound there it silently destroys that worktree's test
// database. `scripts/lib/dev-stack-port-isolation.test.mjs` now fails if either
// file grows its own URL literal again.
//
// Deliberately dependency-free and inside `packages/web`: `Dockerfile.pinchy`
// copies only this package and then runs `pnpm build`, which type-checks the
// vitest config, so anything reached through `../../..` does not exist there.

import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * This worktree's allocated Postgres port.
 *
 * `pnpm worktree:env` writes `DEV_DB_PORT` into the repo-root `.env` so two
 * worktrees can run a stack at once. Precedence: an explicit env var, then that
 * file, then the compose default — a checkout that never allocated is on 5434,
 * exactly as the docs describe.
 */
export function devDbPort(): string {
  if (process.env.DEV_DB_PORT) return process.env.DEV_DB_PORT;
  try {
    // From packages/web/src/test-helpers/integration → repo root.
    const env = readFileSync(path.resolve(__dirname, "../../../../../.env"), "utf8");
    const match = /^\s*(?:export\s+)?DEV_DB_PORT\s*=\s*"?(\d+)"?\s*$/m.exec(env);
    return match ? match[1] : "5434";
  } catch {
    // No `.env` — this worktree never allocated, so it is on the default.
    return "5434";
  }
}

/**
 * The integration suite's test-database URL.
 *
 * `VITEST_INTEGRATION_DB_URL` overrides everything, which is how CI points the
 * suite at its own Postgres service.
 */
export function integrationDbUrl(): string {
  return (
    process.env.VITEST_INTEGRATION_DB_URL ??
    `postgresql://pinchy:pinchy_dev@localhost:${devDbPort()}/pinchy_test_vitest`
  );
}
