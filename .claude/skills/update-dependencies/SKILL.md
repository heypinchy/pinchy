---
name: update-dependencies
description: Use when bumping general npm/pnpm dependencies across the Pinchy workspace (root, packages/web, packages/plugins/*, docs), when the user asks to "update dependencies," "check for outdated packages," or run "pnpm outdated" / "npm update". Not for the pinned OpenClaw core version or openclaw-node — see update-openclaw for those.
---

# Update npm/pnpm Dependencies

## Overview

Pinchy is a pnpm workspace with several independent `package.json`s (root,
`packages/web`, each `packages/plugins/*`, plus the standalone `docs/`
package). A blind "bump everything to latest" misses two kinds of traps:
packages that are pinned together and packages that are pinned apart for a
documented reason.

## Scope

**Excluded from this skill — use `update-openclaw` instead:**
`openclaw` (dev dependency, the pinned core runtime) and `openclaw-node`
(our own client library). OpenClaw upgrades have repeatedly broken Pinchy in
ways `pnpm test`/`tsc` don't catch (session keys, `tools.allow` semantics,
`config.apply` timing) — bumping them needs the dedicated release-notes
review procedure, not a routine sweep. If `pnpm outdated` shows a newer
`openclaw`/`openclaw-node`, list it in your report but do not touch it here;
tell the user to run `update-openclaw` separately.

## Procedure

1. **Enumerate outdated packages per workspace**, not just root:
   ```bash
   pnpm outdated                              # root
   pnpm -C packages/web outdated
   for d in packages/plugins/*/; do pnpm -C "$d" outdated; done
   cd docs && pnpm outdated                    # standalone package.json/lockfile
   ```
   If `node_modules` isn't installed in the current worktree, every row shows
   "missing (wanted X)" — that's not a signal, ignore it. The `wanted →
   latest` columns are what matter.

2. **Bucket every outdated package into one of three groups** before touching
   any file:

   - **Safe patch/minor bump.** Same major version, no known pairing
     constraint. Bump directly.
   - **Paired — must move together, or not at all.** Check before bumping:
     - `next` + `eslint-config-next` (Next.js ships them in lockstep;
       `eslint-config-next` also gates the eslint-v10 blocker below).
     - Any two packages from the same vendor that render/parse together
       (e.g. an avatar/icon library split into a `core` + style package) —
       if only one has a newer major, leave both pinned until the other
       catches up.
     - Any package listed in `pnpm.patchedDependencies` (root `package.json`)
       — a local patch is pinned to an exact version. Bumping needs its own
       step: verify the patch still applies after the bump (`pnpm install`
       fails loudly if it doesn't), and if it no longer applies, regenerate
       it and confirm the behavior it exists for still works (check
       `pnpm patch` history / memory for why the patch exists before
       assuming it's obsolete).
   - **Known blocker or deliberately deferred — do not bump, state why:**
     - `eslint` 9 → 10 is blocked: `eslint-config-next` pulls in
       `eslint-plugin-react`, whose peer range caps ESLint below 10;
       forcing it past that crashes `pnpm lint` at runtime. Recheck when
       `eslint-config-next` ships a major that drops this constraint.
     - A dependency's major version just became `latest` days/weeks ago
       (check `npm view <pkg> time` or the dist-tags) — prefer the newest
       release within the *previous* major and flag the fresh major as a
       separate, deliberate follow-up once it has real-world mileage.
     - A dependency that's a hand-rolled integration point, not a thin
       passthrough (e.g. a PDF/document engine used directly by our own
       extraction/render code) — a major bump there needs its own PR with
       the relevant test suite run against real sample data, not a bundled
       sweep.

3. **Apply the safe-bump and paired-bump groups**, then verify:
   ```bash
   pnpm install
   pnpm -C packages/web lint
   pnpm test                      # root script fans out to workspaces
   pnpm -C packages/web test:db
   pnpm test:scripts
   pnpm build
   pnpm format
   cd docs && pnpm build           # if docs/ package.json changed
   ```
   Run the relevant `pnpm -C packages/web test:e2e:<suffix>` for any plugin
   whose external-API client library was bumped (e.g. `googleapis` →
   `test:e2e:email`).

4. **Report, don't auto-commit.** This touches runtime dependencies, not
   just app code — present the diff (`git status --short`, `git diff --stat`
   per workspace) and the three buckets (bumped / paired-and-bumped /
   deliberately-skipped-with-reason) and let the user decide to commit.
   Give majors you deliberately skipped their own follow-up mention so
   nobody re-attempts them blind next sweep.

## Quick Reference

| Situation | Action |
|---|---|
| `openclaw` / `openclaw-node` outdated | Don't bump here — use `update-openclaw` |
| `eslint` 9 → 10 available | Skip, known peer-dep blocker via `eslint-config-next` |
| Package in `pnpm.patchedDependencies` | Bump in its own commit, re-verify the patch applies |
| Two packages from one vendor, only one has a new major | Leave both pinned until the pair catches up |
| Major version is brand new (days/weeks old) | Take the latest previous-major patch instead, flag the major separately |
| Hand-rolled integration (PDF, parsing engine, etc.) major bump | Own PR, run its specific test suite against real data |
| Any dependency bump at all | Never auto-commit — report the diff and ask |
