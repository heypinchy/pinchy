/**
 * Port allocation for a per-worktree dev stack.
 *
 * The problem this solves: `docker-compose.dev.yml` hard-codes `5434:5432` for
 * Postgres and `8443:443` for Caddy, so the second worktree to run
 * `docker compose … up` fails on a port that is already bound. Everyone worked
 * around it the same way — an untracked `docker-compose.local.yml` with
 * `ports: !override` — which has to be re-derived by hand every time, has to
 * remember that a bare `ports:` APPENDS rather than replaces, and is invisible
 * to anyone else. Two such files were in the tree when this was written, with
 * different conventions.
 *
 * `allocatePorts` picks one free block per worktree instead. The block is
 * written once into a gitignored `.env` and never re-derived, which is what
 * makes the address stable enough to bookmark: re-probing on every `up` would
 * hand a worktree a different port as soon as some unrelated stack happened to
 * hold its old one.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  projectSlug,
  allocatePorts,
  PORT_FAMILIES,
} from "./worktree-ports.mjs";

// ---------------------------------------------------------------------------
// projectSlug: worktree directory -> compose project name
// ---------------------------------------------------------------------------

test("derives the compose project name from the worktree directory", () => {
  assert.equal(
    projectSlug("/repos/pinchy/.claude/worktrees/kb-sources-ui"),
    "kb-sources-ui",
  );
  assert.equal(
    projectSlug("/repos/pinchy.worktrees/eval-v2-crm-domain"),
    "eval-v2-crm-domain",
  );
});

test("normalises what Docker will not accept in a project name", () => {
  // Compose lowercases and strips; deriving the same thing ourselves keeps the
  // name we WRITE identical to the one Docker USES, so `docker compose -p` and
  // the volume prefixes agree.
  assert.equal(
    projectSlug("/repos/worktrees/Feat_Odoo.Sync"),
    "feat-odoo-sync",
  );
  assert.equal(
    projectSlug("/repos/worktrees/feat+piper-tag-permissions"),
    "feat-piper-tag-permissions",
  );
});

test("never returns an empty project name", () => {
  // A trailing slash or a pathological directory name must not produce ""
  // — compose would then fall back to something unpredictable.
  assert.equal(projectSlug("/repos/worktrees/kb-sources-ui/"), "kb-sources-ui");
  assert.notEqual(projectSlug("/repos/worktrees/___"), "");
});

// ---------------------------------------------------------------------------
// allocatePorts
// ---------------------------------------------------------------------------

const allFree = () => true;

test("allocates one port per family, all from the same offset", () => {
  const p = allocatePorts("kb-sources-ui", allFree);
  for (const [name, base] of Object.entries(PORT_FAMILIES)) {
    const offset = p[name] - base;
    assert.ok(offset >= 0, `${name} below its family base`);
    assert.equal(offset, p.offset, `${name} must share the block offset`);
  }
});

test("is deterministic for the same worktree", () => {
  assert.deepEqual(
    allocatePorts("kb-sources-ui", allFree),
    allocatePorts("kb-sources-ui", allFree),
  );
});

test("gives different worktrees different blocks", () => {
  const a = allocatePorts("kb-sources-ui", allFree);
  const b = allocatePorts("worktree-ports", allFree);
  assert.notEqual(a.offset, b.offset);
});

test("skips a block when any of its ports is taken", () => {
  // The whole block moves together — a half-free block is not usable, because
  // the three services come up as one stack.
  const first = allocatePorts("kb-sources-ui", allFree);
  const dbTaken = (port) => port !== PORT_FAMILIES.dbPort + first.offset;
  const second = allocatePorts("kb-sources-ui", dbTaken);
  assert.notEqual(second.offset, first.offset);
  for (const base of Object.values(PORT_FAMILIES)) {
    assert.ok(
      dbTaken(base + second.offset),
      "allocated a port the probe called taken",
    );
  }
});

test("keeps families far enough apart that two blocks can never overlap", () => {
  // Guards the constant, not the code path: if someone narrows a family's
  // range so that `dbPort + offset` can reach `pinchyPort`, two different
  // worktrees would silently share a port and the failure would look like a
  // random stack refusing to start.
  const bases = Object.values(PORT_FAMILIES).sort((a, b) => a - b);
  for (let i = 1; i < bases.length; i++) {
    assert.ok(
      bases[i] - bases[i - 1] > 100,
      `families ${bases[i - 1]} and ${bases[i]} are close enough to collide`,
    );
  }
});

test("reports exhaustion instead of looping forever", () => {
  assert.throws(
    () => allocatePorts("kb-sources-ui", () => false),
    /no free port block/i,
  );
});
