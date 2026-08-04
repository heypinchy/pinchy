#!/usr/bin/env node
/**
 * Write a gitignored `.env` giving THIS worktree its own dev-stack ports, so it
 * can run alongside other worktrees' stacks.
 *
 *   node scripts/worktree-env.mjs          # allocate once, keep what exists
 *   node scripts/worktree-env.mjs --force  # re-allocate (ports moved / conflict)
 *
 * Compose reads `.env` from the project directory automatically, so after this
 * the ordinary command works unchanged:
 *
 *   docker compose -f docker-compose.yml -f docker-compose.dev.yml up
 *
 * Existing keys are never rewritten without `--force`: the address of a
 * worktree should stay bookmarkable, and re-probing on every run would move it
 * as soon as an unrelated stack briefly held one of its ports.
 *
 * The ports are written as DEV_-prefixed keys read only by
 * `docker-compose.dev.yml`. They deliberately do NOT reuse `PINCHY_PORT`,
 * which `docker-compose.yml` reads: Compose loads `.env` for every stack
 * started from the repo root, so that name moved the E2E stacks off :7777 too.
 * A `.env` from the earlier version is migrated automatically on the next run.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
  projectSlug,
  allocatePorts,
  candidatePorts,
  PORT_FAMILIES,
} from "./lib/worktree-ports.mjs";
import {
  MANAGED_KEYS,
  managedValues,
  parseEnvFile,
  writeManagedBlock,
} from "./lib/env-file.mjs";
import { freePorts } from "./lib/port-probe.mjs";

function worktreeRoot() {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      // Silence git's own stderr: the catch below handles "not a repository"
      // perfectly well, and printing `fatal: …` above a successful allocation
      // just makes a working run look broken.
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

const root = worktreeRoot();
const envPath = join(root, ".env");
const force = process.argv.includes("--force");
// Read-then-handle rather than exists-then-read: the check-and-use pair is a
// file-system race (CodeQL js/file-system-race), and "no file yet" is not an
// error case here — it is a worktree that has never been allocated.
let existing = "";
try {
  existing = readFileSync(envPath, "utf8");
} catch {
  existing = "";
}
const parsed = parseEnvFile(existing);

if (!force && MANAGED_KEYS.every((k) => k in parsed)) {
  console.log(
    `.env already allocates this worktree — leaving it alone (--force to re-allocate).`,
  );
  for (const k of MANAGED_KEYS) console.log(`  ${k}=${parsed[k]}`);
  process.exit(0);
}

const slug = projectSlug(root);
// Probe every candidate up front and concurrently, so the allocator itself
// stays a pure synchronous function with a plain predicate — and so this costs
// one pass instead of one probe per candidate.
const free = await freePorts(candidatePorts());
const ports = allocatePorts(slug, (port) => free.has(port));

// Replaces our own block and migrates one written by the pre-rename version;
// everything the developer put in .env themselves is preserved in place.
writeFileSync(
  envPath,
  writeManagedBlock(existing, managedValues({ slug, ports })),
);

console.log(`Allocated block +${ports.offset} for "${slug}":`);
console.log(`  Pinchy    http://localhost:${ports.pinchyPort}`);
console.log(`  Postgres  localhost:${ports.dbPort}`);
console.log(`  Caddy     https://localhost:${ports.caddyPort}`);
console.log(`\nWritten to ${envPath}. Bases: ${JSON.stringify(PORT_FAMILIES)}`);
