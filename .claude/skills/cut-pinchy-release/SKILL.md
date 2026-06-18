---
name: cut-pinchy-release
description: Use when cutting, tagging, or publishing a new Pinchy version — e.g. "cut v0.6.0", "ship the release", "publish the GitHub release", "tag a new version", "release the app". Anything that ends in a vX.Y.Z tag on the Pinchy repo.
---

# Cut a Pinchy Release

## Overview

Pinchy releases are **tag-driven**. One script does everything from a clean `main`:

```bash
git checkout main && git pull --ff-only origin main
pnpm release X.Y.Z       # e.g. pnpm release 0.6.0  (a leading "v" is accepted too — the script normalizes it)
```

That is the only state-changing command. It bumps the version, makes a `chore: release vX.Y.Z` commit, tags, and pushes — and the **tag push** is what triggers `.github/workflows/release.yml` to build images and create the GitHub Release.

> **The Iron Rule: cut every release with `pnpm release X.Y.Z`. NEVER `gh release create`. NEVER a manual `git tag` + push.**

## When to use

- Any request to ship/cut/publish/tag a new Pinchy version.
- NOT for _republishing images_ for a tag that already exists — that is `workflow_dispatch` on the Release workflow with the `tag` input (see CONTRIBUTING.md), and it deliberately does **not** re-create the GitHub Release.

## Why never `gh release create` (the v0.5.5 incident)

`pnpm release` (`scripts/release.mjs`) bumps the version in three files inside the `chore: release vX.Y.Z` commit, **then** pushes the tag:

- `.env.example`
- `package.json`
- `packages/web/package.json`

`packages/web/next.config.ts` derives `NEXT_PUBLIC_PINCHY_VERSION` from `package.json#version`, and `/api/version` reports that value. Skip the bump and the tag says `vX.Y.Z` while `/api/version` still reports the **old** version. This actually shipped on v0.5.5 — someone used a `gh release create` shortcut, so the bump never ran: the tag was `v0.5.5`, but the image baked the stale `package.json` version into `NEXT_PUBLIC_PINCHY_VERSION`, so `/api/version` reported `0.5.4`. Recovery was a whole v0.5.6 patch release.

Second reason the script must push the tag: **the GitHub Release must NOT exist when the workflow starts.** `release.yml` calls `gh release list --limit 1` to find the _previous_ tag, which `extract-upgrade-notes.mjs` needs to build the "Upgrade notes" section of the release body. Pre-creating the release with `gh release create` makes that lookup return the wrong (current) tag. Let the script push; the workflow creates the Release.

## CI enforces this (since PR #454)

A `gh release create` shortcut now fails the workflow **before any artifact exists**, so a botched release leaves no GHCR image to clean up — but it still burns a CI cycle on your deadline:

- **Build-time guard** — `scripts/assert-package-version.mjs <tag>` runs before the image build; fails if `package.json` / `packages/web/package.json` don't match the tag.
- **Runtime guard** — the `end-user-install-published` job smoke-tests `/api/version` against the tag on the _published_ image.

## The upgrade-notes section auto-finalizes (since v0.6.0, the v0.5.8 incident)

`upgrading.mdx` is cumulative: one `## Upgrading from v<prev> to <target>` section per release. During development the **current** section is written with the `%%PINCHY_VERSION%%` placeholder (heading and body), because the next version number isn't known yet. `docs/scripts/inject-version.sh` resolves that placeholder to the **build-time** version — so only the single newest section may carry it; every older section must already be **concrete** (`to vX.Y.Z`).

The v0.5.8 release forgot to freeze its section: the heading stayed `from v0.5.7 to %%PINCHY_VERSION%%` and the body kept literal placeholders. That's a silent time-bomb — the v0.5.8 notes render fine for v0.5.8, then mis-render as the next version's the moment newer docs build. v0.6.0's release prep had to repair it.

Two mechanisms now make this impossible:

- **Auto-finalize in the release commit.** `pnpm release X.Y.Z` calls `finalizeUpgradeSection()` (`scripts/lib/release-logic.mjs`): it freezes the current `from v<prev> to %%PINCHY_VERSION%%` section — heading **and** body placeholders — to `vX.Y.Z`, and includes the edited `upgrading.mdx` in the `chore: release vX.Y.Z` commit. So the release script now touches **four** files, not three: `.env.example`, `package.json`, `packages/web/package.json`, **and** `docs/src/content/docs/guides/upgrading.mdx`.
- **Freshness guard in CI.** `scripts/lib/upgrading-mdx-freshness.test.mjs` (via `assertNoStaleUpgradeSections`, run in `pnpm test:scripts`) fails any PR where a released version's section still carries `%%PINCHY_VERSION%%`, where two sections carry it, or where the placeholder section's `from` doesn't equal `package.json#version` (the latest released version). The preamble / "Standard upgrade" display placeholder is out of scope.

**What this means for you when cutting a release:**

- You only write the **new** `## Upgrading from v<prev> to %%PINCHY_VERSION%%` section (with `%%PINCHY_VERSION%%` placeholders is fine and preferred). The script freezes it for you at release time.
- After a release lands, the **first** upgrade-affecting change should add a fresh `## Upgrading from v<just-released> to %%PINCHY_VERSION%%` section for the next cycle. If nobody does, the next release's gate fails loudly at the start (no `from v<just-released>` section) — which is the safety net, not a surprise.

## Before you run `pnpm release`

**Step 0 — run the preflight and turn every `[ ]` into a blocking task.** `pnpm release:preflight <version>` prints the gate status plus the **manual** gates the script can't enforce: a release-specific staging checklist **auto-derived from this release's upgrade notes** (the `#### …` subheadings under `### Breaking changes` / `### Upgrade notes`), the standard regression smoke, and the PWA check. This exists because manual gates that live only as prose get silently skipped next to the script's hard gates — that is exactly how v0.6.0 shipped with the staging click-through never done.

So, mechanically:

1. Run `pnpm release:preflight <version>`.
2. For **each `[ ]`** it prints, create a task (TodoWrite/Task), and make the `pnpm release` task **`blockedBy`** all of them. Do not start the release task while any remain open.
3. Verify each on the **real `:next` staging instance** (`staging.heypinchy.com`) — it carries the upgrade path + real agents/data; the ephemeral CI E2E stacks don't. The release-specific items are different every release, which is why they're generated from the notes rather than hardcoded.
4. The preflight then prints the exact `pnpm release <version> --verified=$(git rev-parse HEAD)` command. The `--verified` SHA ties your attestation to the commit you actually tested on staging. (A hard `--verified` gate in `release.mjs` is planned once it can be verified end-to-end against a real staging release; today it's enforced by this task discipline + the preflight echo.)

Work through **every** item in **CONTRIBUTING.md § "Pre-release checklist"** — that is the canonical, always-current list, so don't re-derive or copy it. The script and CI already enforce the mechanical gates (clean tree, on `main`, CI green, tag free, `upgrading.mdx` section present with both subsections, `pnpm audit --audit-level=high --prod`). The human judgment calls the script _can't_ enforce — verify each against CONTRIBUTING — include:

- All feature/fix PRs for this release merged to `main`; `pnpm outdated` reviewed.
- `Dockerfile.openclaw` version bumped if OpenClaw was upgraded.
- Model-resolver spot-check if models or templates changed.
- **Ollama Cloud catalog** → run the `update-ollama-cloud-models` skill every release to refresh the catalog.
- `docs/src/content/docs/guides/upgrading.mdx` has a new `## Upgrading from v<prev> to %%PINCHY_VERSION%%` section containing `### Breaking changes` (write "None." if none) and `### Upgrade notes`. The script aborts without it, **freezes the placeholder for you** at release time, and a CI guard rejects stale placeholders — see "The upgrade-notes section auto-finalizes" above.
- Staging (`:next`) click-through + PWA install check.

## After the release

1. **Watch the Release workflow.** `gh run watch "$(gh run list --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')"`. A failure means the release is **not installable** — do not announce until green. Recovery steps are in CONTRIBUTING.md § "If the release workflow fails".
2. **Tags are immutable — never force-update a tag.** A broken release is fixed with a _patch release_, not a re-push.
3. **Re-check deployment overrides.** Any long-running deployment that pins a `docker-compose.override.yml` (to work around upstream bugs not yet fixed) should be reviewed after each release — the upstream fix may have shipped in this release, in which case drop the override.

## Red flags — STOP

| Thought                                                 | Reality                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| "I'll just `gh release create` quickly"                 | That's the v0.5.5 footgun. CI fails it. Use `pnpm release`.                      |
| "I'll `git tag` and push the tag myself"                | Skips the version bump → `/api/version` drifts from the tag. Let the script tag. |
| "I'll pre-create the GitHub Release, then push the tag" | Breaks the PREV-tag lookup for the upgrade notes. Don't.                         |
| "The version bump is just cosmetic"                     | `/api/version` and the public Releases page read it. It IS the shipped version.  |
| "Deadline — skip the checklist"                         | The checklist is the only thing the script _can't_ enforce.                      |
| "I can release from this worktree/branch"               | Releases cut from clean `main` only. The script refuses otherwise.               |
| "`pnpm release` went green, so I'm done"                | Green ≠ verified. The staging click-through + PWA are manual gates the script can't see. Run `release:preflight`, make each `[ ]` a blocking task, verify on `:next` first. |

## Common mistakes

- Editing `package.json#version` by hand instead of letting `pnpm release` bump it — that misses `.env.example`, the commit, and the tag wiring.
- Running from a worktree or feature branch instead of `main`.
- Forgetting the `upgrading.mdx` section → script aborts at the upgrade-notes gate.
- Using `gh release create` "to save a step" → recovery costs a whole patch release.
