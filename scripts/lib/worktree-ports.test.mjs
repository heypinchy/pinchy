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
  candidatePorts,
  unreservedBandConflicts,
  PORT_FAMILIES,
  RESERVED_PORTS,
  MAX_BLOCKS,
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

test("normalises a project name exactly the way Docker does", () => {
  // These expectations are not a guess at Docker's rule — they were measured
  // against it (Docker 29.4.0, `docker compose config --format json | .name`
  // in a directory of that name):
  //
  //   Feat_Odoo.Sync              -> feat_odoosync
  //   feat+piper-tag-permissions  -> featpiper-tag-permissions
  //   -Leading.Dash               -> leadingdash
  //   9start_Name                 -> 9start_name
  //
  // So the rule is: lowercase, DELETE anything outside [a-z0-9_-] (`_` is
  // legal and survives; it is not folded to `-`), then strip leading
  // characters until the name starts with [a-z0-9].
  //
  // Getting this exactly right is the whole point of deriving the name here
  // instead of letting Docker derive it: the name we WRITE has to be the name
  // Docker would have USED, or a stack started with this `.env` and one
  // started without it own two different sets of volumes — and the developer
  // sees an empty dev database with no explanation.
  assert.equal(projectSlug("/repos/worktrees/Feat_Odoo.Sync"), "feat_odoosync");
  assert.equal(
    projectSlug("/repos/worktrees/feat+piper-tag-permissions"),
    "featpiper-tag-permissions",
  );
  assert.equal(projectSlug("/repos/worktrees/-Leading.Dash"), "leadingdash");
  assert.equal(projectSlug("/repos/worktrees/9start_Name"), "9start_name");
});

test("falls back to a usable name where Docker would refuse outright", () => {
  // A trailing slash must not change the answer.
  assert.equal(projectSlug("/repos/worktrees/kb-sources-ui/"), "kb-sources-ui");
  // `___` normalises to "" — Docker rejects that (its project names must match
  // ^[a-z0-9][a-z0-9_-]*$) and refuses to start at all. This is the one place
  // we deliberately diverge: a working stack beats a hard error, and there is
  // no "name Docker would have used" to stay faithful to.
  assert.equal(projectSlug("/repos/worktrees/___"), "pinchy");
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

// ---------------------------------------------------------------------------
// Reserved ports
// ---------------------------------------------------------------------------

test("never allocates a port another stack has already claimed", () => {
  // A probe only sees what is bound RIGHT NOW, and allocation is sticky by
  // design. So a worktree allocated while the integration stack happens to be
  // down would take 7779 and KEEP it — and every later
  // `pnpm test:e2e:integration` in that worktree dies on a bound port, with
  // nothing pointing back here. Reserved ports are excluded from the bands
  // regardless of whether anything is listening at the time.
  for (const slug of [
    "kb-sources-ui",
    "worktree-ports",
    "eval-v2",
    "a",
    "zz",
  ]) {
    const p = allocatePorts(slug, allFree);
    for (const name of Object.keys(PORT_FAMILIES)) {
      assert.ok(
        !RESERVED_PORTS.has(p[name]),
        `${slug}: allocated reserved port ${p[name]} (${name})`,
      );
    }
  }
});

test("still reports exhaustion when only reserved ports would be left", () => {
  // The reserved set must shrink the search space, not make it silently wrap.
  const onlyReservedFree = (port) => RESERVED_PORTS.has(port);
  assert.throws(
    () => allocatePorts("kb-sources-ui", onlyReservedFree),
    /no free port block/i,
  );
});

// ---------------------------------------------------------------------------
// unreservedBandConflicts — the input to the repo-wide drift guard
// ---------------------------------------------------------------------------

test("flags a hard-coded port that falls inside a band", () => {
  const inBand = PORT_FAMILIES.pinchyPort + 5;
  assert.deepEqual(unreservedBandConflicts([inBand]), [inBand]);
});

test("ignores ports outside every band and ports that are reserved", () => {
  const reserved = [...RESERVED_PORTS][0];
  assert.deepEqual(unreservedBandConflicts([1234, 65000, reserved]), []);
});

test("reports each conflicting port once, in ascending order", () => {
  const a = PORT_FAMILIES.dbPort + 7;
  const b = PORT_FAMILIES.caddyPort + 3;
  assert.deepEqual(unreservedBandConflicts([b, a, a, b]), [a, b]);
});

test("candidatePorts covers every port a block could ever use", () => {
  const candidates = new Set(candidatePorts());
  for (const base of Object.values(PORT_FAMILIES)) {
    for (let i = 0; i < MAX_BLOCKS; i++) {
      assert.ok(candidates.has(base + i), `missing candidate ${base + i}`);
    }
  }
  assert.equal(
    candidates.size,
    Object.keys(PORT_FAMILIES).length * MAX_BLOCKS,
    "candidatePorts must not probe ports outside the bands",
  );
});
