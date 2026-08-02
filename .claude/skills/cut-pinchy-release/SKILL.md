---
name: cut-pinchy-release
description: Use when cutting, tagging, or publishing a new Pinchy version — e.g. "cut v0.6.0", "ship the release", "publish the GitHub release", "tag a new version", "release the app". Anything that ends in a vX.Y.Z tag on the Pinchy repo.
---

# Cut a Pinchy Release

## Overview

Pinchy releases are **tag-driven**. One script does everything from a clean `main` (or a `release/X.Y` branch — see "Release branches" below):

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

Three mechanisms now make this impossible:

- **Auto-finalize in the release commit.** `pnpm release X.Y.Z` calls `finalizeUpgradeSection()` (`scripts/lib/release-logic.mjs`): it freezes the current `from v<prev> to %%PINCHY_VERSION%%` section — heading **and** body placeholders — to `vX.Y.Z`, and includes the edited `upgrading.mdx` in the `chore: release vX.Y.Z` commit. So the release script now touches **four** files, not three: `.env.example`, `package.json`, `packages/web/package.json`, **and** `docs/src/content/docs/guides/upgrading.mdx`.
- **Auto-open the next section**, in a **second commit made after the tag**. `openNextUpgradeSection()` adds a fresh `## Upgrading from vX.Y.Z to %%PINCHY_VERSION%%` skeleton (both `###` subsections plus the standard-flow bash block) so the next cycle's first upgrade note has somewhere correct to land. It sits after the tag on purpose: the tagged tree is what the docs deploy builds, and `inject-version.sh` would render a skeleton inside the release commit as an empty "Upgrading from vX.Y.Z to vX.Y.Z" section on the live guide.
- **Two guards in CI.** `scripts/lib/upgrading-mdx-freshness.test.mjs` (via `assertNoStaleUpgradeSections`, run in `pnpm test:scripts`) fails any PR where a released version's section still carries `%%PINCHY_VERSION%%`, where two sections carry it, or where the placeholder section's `from` doesn't equal `package.json#version`. The preamble / "Standard upgrade" display placeholder is out of scope. `scripts/lib/upgrading-released-sections.mjs` fails any PR that edits an **already-released** section without an `Allow-upgrade-note-edit: #NNN` trailer or the `allow-upgrade-note-edit` label — see AGENTS.md § "A Released Upgrade Section Is Immutable".

**What this means for you when cutting a release:**

- You only write the **new** `## Upgrading from v<prev> to %%PINCHY_VERSION%%` section (with `%%PINCHY_VERSION%%` placeholders is fine and preferred). The script freezes it for you at release time.
- The next cycle's section is opened for you by the release run, so notes written after a release land in it rather than in the section that just shipped. If it is somehow missing — a hand-cut release, a forward-port that dropped it — the next release's gate still fails loudly at the start (no `from v<just-released>` section), which is the safety net, not a surprise.

## Release branches (GitLab-Flow-style)

`main` is trunk — features keep landing on it, always. A `release/X.Y` branch is cut per **minor** version, from a frozen, known-good ref, when the scope for that minor is decided. It hosts vX.Y.0 **and** every patch after it (vX.Y.1, vX.Y.2, …) — one branch per minor, not one per patch. `main` keeps flowing and becomes the next minor. `pnpm release` and `pnpm release:preflight` accept both `main` and any `release/*` branch; anything else is rejected.

- **Upstream first — the load-bearing rule.** A fix lands on `main` **first**, then is cherry-picked to `release/X.Y`. This makes "main never loses a fix" structural rather than a remember-to-back-merge chore. Back-merge (release branch → main) is only for a fix that is genuinely branch-specific — main has already refactored the affected code away and the fix doesn't apply there.
- **Testing the candidate on staging.** Staging's `:next` tag tracks `main`, so it is the wrong pin for a release-branch candidate. `.github/workflows/pre-release.yml` builds `release/X.Y` pushes to a **branch-scoped moving tag** `rc-X.Y` (e.g. `release/0.9` → `rc-0.9`) instead of `next` — this keeps two concurrent release branches from clobbering each other's candidate image. Pin staging to either `:sha-<short12>` (an exact ref) or `:rc-X.Y` (latest on the branch), never `:next`, while verifying a release-branch candidate.
- **Releasing.** Run `pnpm release X.Y.Z` **from `release/X.Y`** — same Iron Rule, same script, just a different branch checked out. The tag push still triggers `release.yml` (tag-triggered, branch-agnostic — nothing changes there). A patch release is more upstream-first fixes cherry-picked onto `release/X.Y`, then `pnpm release X.Y.(Z+1)` from that branch.
- **Forward-port `upgrading.mdx` after release.** `pnpm release` freezes the current section's `%%PINCHY_VERSION%%` placeholders in the `chore: release` commit, and opens the next cycle's section in the follow-up commit — **both on the release branch**. Both must also reach `main`, or main's upgrade notes keep stale placeholders, lose the frozen section, and have no open section for the next note to land in. Cherry-pick both `upgrading.mdx` commits (or just those hunks) to `main` as an explicit post-release step. **Caveat while #1028 is open:** `main`'s `package.json` is not bumped by a release-branch cut, so forward-porting the _open_ section alone turns the freshness guard red on `main` (it requires the placeholder section's `from` to equal `package.json#version`). Bump `main`'s version in the same forward-port, or resolve #1028 first. Version bumps (`package.json`, `.env.example`, marketplace pins) stay on the release branch — `main` re-bumps at its own next cut.

## Before you run `pnpm release`

**Step 0 — run the preflight and turn every `[ ]` into a blocking task.** `pnpm release:preflight <version>` prints the gate status plus the **manual** gates the script can't enforce: a release-specific staging checklist **auto-derived from this release's upgrade notes** (the `#### …` subheadings under `### Breaking changes` / `### Upgrade notes`), the standard regression smoke, and the PWA check. This exists because manual gates that live only as prose get silently skipped next to the script's hard gates — that is exactly how v0.6.0 shipped with the staging click-through never done.

So, mechanically:

1. Run `pnpm release:preflight <version>`.
2. For **each `[ ]`** it prints, create a task (TodoWrite/Task), and make the `pnpm release` task **`blockedBy`** all of them. Do not start the release task while any remain open.
3. Verify each on the **real staging instance** (`staging.heypinchy.com`), pinned to the candidate image the preflight names — `:next` when you are cutting from `main`, `:rc-X.Y` (or `:sha-<short12>`) from a `release/X.Y` branch, see § "Release branches". Staging carries the upgrade path + real agents/data; the ephemeral CI E2E stacks don't. The release-specific items are different every release, which is why they're generated from the notes rather than hardcoded.
4. The preflight then prints the exact `pnpm release <version> --verified=$(git rev-parse HEAD)` command. The `--verified` SHA ties your attestation to the commit you actually tested on staging. (A hard `--verified` gate in `release.mjs` is planned once it can be verified end-to-end against a real staging release; today it's enforced by this task discipline + the preflight echo.)

### Build the test plan from the FULL changelog, then split it agent vs human

The preflight's staging checklist is auto-derived from the **upgrade notes** (`####` subheadings) — that is a **subset**, not the coverage plan. Upgrade notes call out breaking changes and what an operator must know; they miss most shipped features (v0.9.0's Knowledge Base, IMAP connect flow, chat slash-commands, `odoo_reconcile`, auth error-honesty were none of them upgrade-note subheadings). Build the actual plan from the full changelog:

```bash
git log v<prev>..main --no-merges --pretty=format:'%s' | grep -iE '^(feat|fix)'
```

Then three moves before you test anything:

1. **Scope out what has no runtime surface — don't test it.** Dark foundations (schema/tables/plumbing merged ahead of the feature that will consume them — grep the upgrade notes and commit bodies for "foundation" / "no runtime surface") and internal-only tooling (`eval`, CI guards, `scripts/`) are not user-testable. v0.9.0 shipped ~75 such commits (the whole `inbox-agent`/email-workflows cluster + `eval`/`kb-eval`). Listing them as "to test" burns actions hunting for UI that doesn't exist — name them explicitly as out-of-scope so the human doesn't hunt either.

2. **Cluster into minimum-action super-flows.** One well-chosen end-to-end flow exercises many features + fixes at once: a KB-agent setup+query covers ingest, pgvector, hybrid retrieval, citations, abstention, offline embedding and a dozen KB fixes in two questions; an email→Odoo booking covers read, attachment, vision, `odoo_read`/`create`/`reconcile`, duplicate-guard and audit in one run. Optimize for max coverage per action, not one test per commit.

3. **Split every cluster into an agent half and a human half — and hand the human theirs explicitly.** This is sharper than the test-and-fix loop's "gates only a human _can_ close" item below: it divides _every_ feature, not just the agent-impossible ones.
   - **The agent owns the plumbing / logic / honesty half** — anything verifiable against ground truth: tool round-trips via the audit log, API responses to crafted inputs (auth error semantics, open-redirect / SSRF rejection, credential masking), DB & migration state, config emission, retrieval correctness (citations point at real passages, abstention fires). Drive it and confirm against evidence, per the loop below.
   - **The human owns ALL UI/UX, plus edge-cases and real devices** — not as leftovers but because they need the human feel the agent lacks: every wizard / flow / rendering / interaction (the IMAP connect wizard, slash-command discoverability, citation rendering, hover/paste behavior, dialog layout), anything on real hardware (PWA install + share-target), and the weird-behavior / edge-case hunting a human is simply better at. A feature with both halves (IMAP: API layer vs. connect wizard) is split down the middle — agent takes the API, human takes the wizard.

   Deliver the split as a table (cluster → agent verifies X / human checks Y), the human half prioritized, **before** you start driving your half.

### The staging pass is an active test-and-fix loop — not a click-through

The CONTRIBUTING item reads "clicked through today," but a passive click-through is the weakest form of this gate — it confirms the app _boots_, not that the release _works_. The version that actually catches blockers, and is now the standard, is an **autonomous test-and-fix loop** you run yourself before handing back for the human's "go" (the v0.8.0 email→Odoo pass caught three shippable blockers this way — a false-success invoice read, a missing vision fallback, and a duplicate-booking bug):

1. **Deploy the release candidate to staging yourself, then verify against _that_ build.** After the fixes land, wait for `pre-release.yml` to publish this branch's candidate image (`:next` from `main`, `:rc-X.Y` from `release/X.Y`), refresh staging (`docker compose pull && up -d && docker image prune -f`), and confirm the regenerated `openclaw.json` actually reflects the change. Verifying against a stale image proves nothing — and on a release branch, verifying against `:next` proves something about `main` instead.
2. **Drive real end-to-end flows, adversarially — the goal is to _find_ problems.** Exercise the actual agents through the actual integrations, covering the archetypes: the default agent, each external integration (email, Odoo, …), an analytics/data agent, and a knowledge-base agent. Include the enforcement paths (`tools.allow` fail-closed, permission scoping) and the recovery paths (reconcile-on-reload). "More problems found is better," not "confirm none exist."
3. **Verify against ground truth, not the UI.** "Looks fine in the chat" is not verification — that is exactly how a false-success PDF read once shipped, and this session the live UI even hid a completed reply behind a streaming disconnect. Confirm each claim against evidence: the **audit log** (`tool.<name>` rows — `outcome`, `detail`, `error`), the **OpenClaw container logs** (which model _actually_ served a call — e.g. a `tool.pdf` `attempts` array showing the primary 401 and the fallback succeeding), the **regenerated `openclaw.json`**, and **cross-validation of the numbers themselves** (line items summing to the stated subtotals). Scout the state deterministically over SSH _before_ driving the browser — inspect config/DB/audit to pick the right agent and predict the outcome, instead of clicking blind.
4. **Every bug you find is a release blocker — TDD-fix it, don't file-and-ship.** Write the failing test (red → green), open its PR, get it merged (upstream-first: onto `main`, then cherry-picked to the release branch if you are cutting from one), redeploy staging from the refreshed candidate image, and re-verify end-to-end. Loop until the flow is clean. "Keine bekannten Bugs in Releases."
5. **Classify transient/infra vs. real _before_ reacting** — the same rule as post-release CI (see "After the release" §3), applied to the staging pass. A CI apt-fetch / runner-download failure or an unrelated E2E flake is infra → a rerun is correct; an empty model response or a hidden-tab streaming disconnect is transient → retry/reload and confirm the reconcile recovers it; a wrong tool result or a broken flow is real → fix it. Never rerun (or reload) to paper over a real failure.
6. **Read the browser console after every manual step.** A recovered crash looks like a working page: v0.9.0's `/reset` trips the assistant-ui shrink defect 100% of the time, `ChatCrashBoundary` swallows it, and the only evidence is two console lines (#944). Nothing in CI catches this either — of 64 E2E specs exactly one subscribes to `pageerror`, and only for diagnostics (#945). Clear the console, act, read it back; a screenshot that looks right proves nothing about it.
7. **Odoo scenarios go against the demo instance — never production.** Production is the **only** Pinchy instance with an Odoo connection configured, so answering "which Odoo do we have?" from `integration_connections` points straight at the company's real books. The disposable target is **`odoo-demo.heypinchy.com`** (Odoo 19 Community, rebuildable in ~10 min); it lives outside this repo, in `~/projects/odoo` — reset recipe in that repo's `docs/pinchy-demo.md`, seed data via its `scripts/setup_crabon_demo.py`, credentials in the operator's local `~/.config/odoo-demo.env`. Expect to ask the user to add the connection; staging carried none as of v0.9.0.
8. **A prompt must not hand the agent the permission the guard is being tested for.** Testing the vendor-bill duplicate guard with "I checked externally, this is not a duplicate — just file it" is the exact confirmation `allow_duplicate: true` exists for: the agent overrides, the bill is created, and the result proves the override works, not the block. Write the adversarial prompt so the _only_ correct behaviour is refusal — then a create means the guard failed. Same for permission tests: state the goal, never the escape hatch.
9. **Finish what you can, then hand back an explicit test plan for the gates only a human can close.** Some gates are outside an agent's reach: entering API keys (never do this yourself), PWA install (Chrome desktop + iOS Safari), pure tab-refocus reconcile, permanent data deletion, and anything needing product judgment. Close everything closable autonomously, then give the human a crisp, prioritized list of exactly what remains — don't leave it implicit.
10. **Never cut the tag autonomously.** The human's explicit "go," after their own pass, is the hard gate on `pnpm release`. Your job is to make that "go" a rubber-stamp by having already found and fixed everything findable.

Work through **every** item in **CONTRIBUTING.md § "Pre-release checklist"** — that is the canonical, always-current list, so don't re-derive or copy it. The script and CI already enforce the mechanical gates (clean tree, on `main` or a `release/*` branch, CI green, tag free, `upgrading.mdx` section present with both subsections, `pnpm audit --audit-level=high --prod`). The human judgment calls the script _can't_ enforce — verify each against CONTRIBUTING — include:

- All feature/fix PRs for this release merged to `main`; `pnpm outdated` reviewed.
- `Dockerfile.openclaw` version bumped if OpenClaw was upgraded.
- Model-resolver spot-check if models or templates changed.
- **Ollama Cloud catalog** → run the `update-ollama-cloud-models` skill every release to refresh the catalog.
- `docs/src/content/docs/guides/upgrading.mdx` has a new `## Upgrading from v<prev> to %%PINCHY_VERSION%%` section containing `### Breaking changes` (write "None." if none) and `### Upgrade notes`. The script aborts without it, **freezes the placeholder for you** at release time, and a CI guard rejects stale placeholders — see "The upgrade-notes section auto-finalizes" above.
- Staging click-through on this branch's candidate image (`:next` / `:rc-X.Y`) + PWA install check.
- Security review over the whole `v<prev>..HEAD` release delta — see the section right below.

### Run a security review over the whole release delta — after the staging pass, before the cut

Not instead of per-PR review, and not per PR. It belongs **here**, at the end, because the two most valuable kinds of finding are ones no per-PR review can produce:

- **What the backport dropped.** A security fix can sit merged on `main` and simply not be in the branch you are tagging. Four v0.9.0 findings were exactly that. Three of them: `mail-host-guard.ts` absent from `release/0.9` while the IMAP routes it guards were present; and — both in `openclaw-config/write.ts` — the plaintext guard's on-disk **baseline** absent, so on an install already carrying a legacy plaintext key the absolute scan rejected the payload of every targeted write, and the **terminal `.catch`** on `pushConfigInBackground` absent, so that rejection became an unhandled rejection in a voided coroutine. Net effect: a Telegram disconnect answers HTTP 200 with `outcome: "success"` from the route while the config write carrying the removal is dropped — the bot token stays live. Every one had been reviewed and approved on `main`. The defect is the backport, and only a whole-delta review sees it. This is the sharpest argument for the release-branch model having a gate of its own.
- **What only composes across PRs.** v0.9.0's critical finding was three individually-reasonable pieces: PATCH never gated `pluginConfig` (old), `allowed_paths` was confined in POST only (old), and a new route read that field to serve bytes to the browser (new, this release). Together: any member could read the AES master key. No single PR contains that bug.

Mechanically:

1. **Scope the diff yourself, explicitly.** `/security-review` picks its own working directory — in the v0.9.0 pass it silently reviewed an **empty** diff in an unrelated worktree, and would have reported no findings. State the range and the checkout: `v<prev>..HEAD` in the release-branch worktree, and sanity-check `git diff --stat` before believing any verdict, a clean one most of all.
2. **Partition by attack surface, one reviewer each** — auth/authorization, API routes, secrets handling, the WS bridge, plugins, config emission. Give each hard exclusions so they don't all re-read the same files, and a confidence bar so you get findings instead of everything that could theoretically be wrong. A surface reported clean **with what it ruled out** is a useful answer; "no findings" alone is not.
3. **Verify every finding against the source before acting on it.** An agent reporting a fail-open is not a fail-open. Two v0.9.0 findings turned out narrower than reported and one turned out **wider**: `/^fc00:/` was reported as missing `fd00::/8`, but ULA is `fc00::/7` and that regex anchors a whole hextet — so it matched only literal `fc00:` and let through nearly all of `fc00::/7`, `fc01:`–`fdff:`, `fd00::/8` (the half actually in use) included. The fix is `/^f[cd][0-9a-f]{2}:/i`, and the same read turned up `::` unguarded beside it. Read the pattern, don't accept the summary.
4. **Findings are release blockers, exactly like staging-pass bugs — TDD-fix them, don't file-and-ship.** Then distrust the fix's own test: a mocked `fetch` never follows a redirect, so three "refuses to follow the redirect" tests passed identically against the vulnerable code. Run every new security test against the **unpatched** source and watch it fail before you believe it.

### Classify the docs delta between the release branch and `main` — before the cut

Short, and not optional. The docs published from this branch are what users read about the version they run, so a correction stranded on `main` is a wrong page in front of customers for a whole cycle. v0.9.0 shipped exactly one such error and it stood the whole time: `llm-providers.mdx` on `release/0.9` said "Pinchy will not silently re-assign agents" while the shipped `DELETE /api/settings/providers` migrates them. The corrected sentence had been on `main` since before the cut.

```bash
git diff --stat origin/release/X.Y origin/main -- docs/src/content/docs/
```

Read the diff and put **every hunk** in one of two buckets:

- **A feature only `main` has** → leave it. Documenting it here would promise users something this release does not contain.
- **A correction to something this release ships** → backport it. Wrong is wrong in both branches.

The tell is not the size of the hunk, it's what it replaces: an **added section** is usually a new feature, a **changed sentence** is usually a fix. Read the changed sentences first.

Don't shortcut this by deploying docs from `main`. Pinning the docs to the release is what makes them describe the software users actually run.

### Read the guides for what changed this cycle

CI now covers the mechanical half — `docs-coverage`, `docs-consistency` and `check-docs-required` run on every PR, so by the time you are here no API route, audit event or tool is missing from a reference and no page is orphaned. Don't re-do that by hand.

What's left is the reading, and it's the part that found the real damage in the v0.9.0 audit: a documented response body that was fiction, a page contradicting itself 120 lines apart, a table listing 2 of 35 templates. Use the `review-docs` skill, scoped to the features this release changed.

### After the docs deploy, verify the live site

"Workflow green" is not "content right" — v0.5.8 proved that when the version-placeholder freeze silently didn't happen. Once `screenshots.yml` has deployed, check on docs.heypinchy.com itself:

- the upgrade guide's newest heading names **this** version, and no `%%PINCHY_VERSION%%` survives anywhere;
- the install snippets pin this version;
- the pages for whatever this release changed actually say the new thing.

## After the release

1. **Watch BOTH post-tag runs to a _verified_ green — never trust a watch's exit code.** The tag push starts the **Release** workflow (images + GitHub Release) **and** a fresh **CI** run on the new `chore: release` commit. That commit carries new content the pre-release CI never saw — the version bumps and the **auto-finalized `upgrading.mdx`** — which is exactly how v0.6.0 turned `main` red (the finalize removed the `%%PINCHY_VERSION%%` placeholder a test anchored on). So a green pre-release CI does **not** mean the release commit is green.
   - `gh run watch <id>` and `gh pr checks --watch` **routinely exit 0 prematurely**: right after a push no checks are registered yet (zero-checks race), and staged `needs:` jobs (E2E) only start after the build job. The watch exiting is not proof.
   - **Confirm the authoritative signal instead:** `gh run view <id> --json status,conclusion` → `completed` / `success` with no failed jobs; and for a PR, `gh pr view <n> --json mergeStateStatus` → `CLEAN` (not `UNSTABLE`/`BLOCKING`). Only then merge/announce. A Release-workflow failure means the release is **not installable** — recovery in CONTRIBUTING.md § "If the release workflow fails".
2. **Deploy the release to the demo + production instances.** The published images do NOT deploy themselves — staging tracks `:next`, but demo and production pin `${PINCHY_VERSION}` and only move when an operator bumps it and pulls. Skip this and the release reaches no users: production sat on v0.5.8 across several releases for exactly this reason (no plan step → forgotten), so it missed the v0.7.0 cookie-stability and plugin-deps fixes. On each instance: bump `PINCHY_VERSION` in its `.env` → `docker compose pull && docker compose up -d && docker image prune -f` → verify `/api/version` reports the new tag + a quick smoke. Mind cross-release migrations when skipping versions (e.g. the v0.7.0 cookie one-time relogin; additive DB migrations run on boot). Treat production as a confirm-first, outward action. NB: superseded once auto-deploy on push to `main` lands (#184, slated for v0.8.0).
3. **Red CI: classify transient vs. real before reacting.** Is `main` green for the same check? A crash in **Node/pnpm internals** during dependency download (e.g. an undici `assert(!this.paused)`), a **6h runner stall**, or a **fresh OSV advisory** are infrastructure → a rerun is the correct response. A failure in our own test/build logic is real → fix it, don't blind-rerun. (Flaky _tests we own_ get fixed at the root, never papered over with reruns.)
4. **Tags are immutable — never force-update a tag.** A broken release is fixed with a _patch release_, not a re-push.
5. **Re-check deployment overrides.** Any long-running deployment that pins a `docker-compose.override.yml` (to work around upstream bugs not yet fixed) should be reviewed after each release — the upstream fix may have shipped in this release, in which case drop the override.
6. **Update the marketing website.** Reflect the release on heypinchy.com. It's a **separate, private repo** (`heypinchy/website`) with its own deploy (push to `main` → S3/CloudFront) and its own release-update checklist, so **nothing in this flow touches it automatically** — unlike `docs.heypinchy.com`, which the release workflow deploys. Finalize the release blog post + screenshots of the shipped UI, update the feature grid / affected feature pages, and refresh `/vs/*` competitor claims, per that repo's `CLAUDE.md` → "Release update workflow". The canonical checklist item lives in CONTRIBUTING.md § "Pre-release checklist" → **Marketing website**.

## Red flags — STOP

| Thought                                                      | Reality                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "I'll just `gh release create` quickly"                      | That's the v0.5.5 footgun. CI fails it. Use `pnpm release`.                                                                                                                                                                                                                                                                                                                                                                                  |
| "I'll `git tag` and push the tag myself"                     | Skips the version bump → `/api/version` drifts from the tag. Let the script tag.                                                                                                                                                                                                                                                                                                                                                             |
| "I'll pre-create the GitHub Release, then push the tag"      | Breaks the PREV-tag lookup for the upgrade notes. Don't.                                                                                                                                                                                                                                                                                                                                                                                     |
| "The version bump is just cosmetic"                          | `/api/version` and the public Releases page read it. It IS the shipped version.                                                                                                                                                                                                                                                                                                                                                              |
| "Deadline — skip the checklist"                              | The checklist is the only thing the script _can't_ enforce.                                                                                                                                                                                                                                                                                                                                                                                  |
| "I can release from this worktree/branch"                    | Releases cut from clean `main` or a `release/X.Y` branch only. The script refuses any other branch (including ad-hoc worktree/feature branches).                                                                                                                                                                                                                                                                                             |
| "`pnpm release` went green, so I'm done"                     | Green ≠ verified. The staging click-through + PWA are manual gates the script can't see. Run `release:preflight`, make each `[ ]` a blocking task, verify on the staging pin it names (`:next` / `:rc-X.Y`) first.                                                                                                                                                                                                                           |
| "Staging booted / I clicked through it, so that gate's done" | Booting ≠ working. Run the **active test-and-fix loop**: drive real flows adversarially, verify against the audit log + OpenClaw logs (not the UI), and TDD-fix every bug you find before the cut.                                                                                                                                                                                                                                           |
| "Per-PR review covered the security side"                    | It structurally cannot see the two findings that matter most here: a fix that never got backported to the release branch, and a hole that only composes across PRs. Run the whole-delta review before the cut.                                                                                                                                                                                                                               |
| "The security review came back clean"                        | On which diff, in which worktree? `/security-review` chooses its own directory and will happily report a clean **empty** diff. Confirm the range with `git diff --stat` before trusting a clean verdict.                                                                                                                                                                                                                                     |
| "The new security test passes"                               | Passing proves nothing until it has FAILED against the unpatched source. Three "refuses to follow the redirect" tests passed either way, because a mocked `fetch` never follows one.                                                                                                                                                                                                                                                         |
| "That fix is on `main`, so it's in the release"              | Only if somebody picked it. Ask git, after a `git fetch` — a stale remote ref answers about yesterday's branch: `git merge-base --is-ancestor <sha> origin/release/X.Y; echo $?` → `0` in, `1` missing, anything else means your sha or ref is wrong. `--is-ancestor` prints nothing, so read the code, and don't let `\|\| echo missing` swallow a bad sha as "missing". A commit title says what the commit intended, not where it landed. |
| "The watch exited 0, so CI is green"                         | `gh run/pr checks --watch` exits early when checks register late (right after a push) or stage in via `needs:`. Confirm `conclusion: success` + `mergeStateStatus: CLEAN` before merging/announcing.                                                                                                                                                                                                                                         |
| "Pre-release CI was green, so the release commit is fine"    | The `chore: release` commit adds the version bumps + the auto-finalized `upgrading.mdx`. Watch the fresh CI run on that commit too — v0.6.0 turned main red exactly here.                                                                                                                                                                                                                                                                    |
| "CI is red — rerun it"                                       | Classify first. Infra (Node/pnpm crash, runner stall, fresh OSV) with `main` green → rerun. Our own test/build → real, fix it.                                                                                                                                                                                                                                                                                                               |
| "The endpoint answered 200, so the credential is valid"      | Check _which_ endpoint authenticates. Ollama Cloud's `/api/tags` and `/v1/models` return 200 for **any** token — only `/v1/chat/completions` authenticates. State what the evidence covers, not what it suggests.                                                                                                                                                                                                                            |
| "It's not in Pinchy's DB, so it doesn't exist"               | Pinchy's tables only know what is wired into Pinchy. The demo Odoo, the seed scripts, the local `~/projects` repos are all invisible there. Check the world, not one table — and reconcile against recorded memory before contradicting it.                                                                                                                                                                                                  |
| "The test suite went red, so something broke"                | Was more than one heavy job running? Three concurrent vitest processes produced 65 "failing" files that were pure contention. One heavy job at a time, or the run is not evidence.                                                                                                                                                                                                                                                           |
| "The agent said it worked"                                   | Re-read the store. A reconcile claim is true only if `amount_residual` really fell to 0 and both journal lines carry `reconciled = t`; the E2E mock zeroes that field itself, which is exactly why the live check exists.                                                                                                                                                                                                                    |

## Common mistakes

- Editing `package.json#version` by hand instead of letting `pnpm release` bump it — that misses `.env.example`, the commit, and the tag wiring.
- Running from a worktree or feature branch instead of `main` or a `release/X.Y` branch.
- Forgetting the `upgrading.mdx` section → script aborts at the upgrade-notes gate.
- Using `gh release create` "to save a step" → recovery costs a whole patch release.
