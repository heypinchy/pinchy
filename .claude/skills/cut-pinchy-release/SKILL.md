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

## Before you run `pnpm release`

Work through **every** item in **CONTRIBUTING.md § "Pre-release checklist"** — that is the canonical, always-current list, so don't re-derive or copy it. The script and CI already enforce the mechanical gates (clean tree, on `main`, CI green, tag free, `upgrading.mdx` section present with both subsections, `pnpm audit --audit-level=high --prod`). The human judgment calls the script _can't_ enforce — verify each against CONTRIBUTING — include:

- All feature/fix PRs for this release merged to `main`; `pnpm outdated` reviewed.
- `Dockerfile.openclaw` version bumped if OpenClaw was upgraded.
- Model-resolver spot-check if models or templates changed.
- **Ollama Cloud catalog** → run the `update-ollama-cloud-models` skill every release to refresh the catalog.
- `docs/src/content/docs/guides/upgrading.mdx` has a new `## Upgrading from v<prev> to %%PINCHY_VERSION%%` section containing `### Breaking changes` (write "None." if none) and `### Upgrade notes`. The script aborts without it.
- Staging (`:next`) click-through + PWA install check.

## After the release

1. **Watch the Release workflow.** `gh run watch "$(gh run list --workflow Release --limit 1 --json databaseId --jq '.[0].databaseId')"`. A failure means the release is **not installable** — do not announce until green. Recovery steps are in CONTRIBUTING.md § "If the release workflow fails".
2. **Tags are immutable — never force-update a tag.** A broken release is fixed with a _patch release_, not a re-push.
3. **Re-check the production-server overrides.** `demo.heypinchy.com` and `pinchy.heypinchy.com` both track released tags and each carry a `docker-compose.override.yml` holding workarounds for upstream bugs. After each release, check whether the override is still needed (the upstream fix may have shipped in this release) and remove it if not.

## Red flags — STOP

| Thought                                                 | Reality                                                                          |
| ------------------------------------------------------- | -------------------------------------------------------------------------------- |
| "I'll just `gh release create` quickly"                 | That's the v0.5.5 footgun. CI fails it. Use `pnpm release`.                      |
| "I'll `git tag` and push the tag myself"                | Skips the version bump → `/api/version` drifts from the tag. Let the script tag. |
| "I'll pre-create the GitHub Release, then push the tag" | Breaks the PREV-tag lookup for the upgrade notes. Don't.                         |
| "The version bump is just cosmetic"                     | `/api/version` and the public Releases page read it. It IS the shipped version.  |
| "Deadline — skip the checklist"                         | The checklist is the only thing the script _can't_ enforce.                      |
| "I can release from this worktree/branch"               | Releases cut from clean `main` only. The script refuses otherwise.               |

## Common mistakes

- Editing `package.json#version` by hand instead of letting `pnpm release` bump it — that misses `.env.example`, the commit, and the tag wiring.
- Running from a worktree or feature branch instead of `main`.
- Forgetting the `upgrading.mdx` section → script aborts at the upgrade-notes gate.
- Using `gh release create` "to save a step" → recovery costs a whole patch release.
