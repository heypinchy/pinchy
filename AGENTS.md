# AGENTS.md - Pinchy

## Purpose

Pinchy is an enterprise AI agent platform built on top of OpenClaw. OpenClaw is the agent runtime; Pinchy adds the enterprise layer: permissions, audit trails, user management, governance, and deployment.

Status: early development. The core is working: setup wizard, authentication, provider configuration, OpenClaw-backed agent chat, allow-listed agent permissions, knowledge base agents, user invites, personal/shared agents, per-user/org context, Smithers onboarding, audit trail, Telegram channel integration, and Docker Compose deployment. Granular RBAC, plugin marketplace, and more channel integrations are planned.

## Repository Map

- `packages/web/` - Next.js app, API routes, WebSocket bridge, Drizzle schema/migrations, tests.
- `packages/plugins/` - OpenClaw plugins. Current Pinchy plugins: `pinchy-files`, `pinchy-context`, `pinchy-docs`, `pinchy-audit`, `pinchy-email`, `pinchy-odoo`, `pinchy-transcript`, `pinchy-web`.
- `config/` - OpenClaw config support, startup scripts, mock services for integration/E2E tests.
- `docs/` - Astro Starlight documentation. It is standalone and has its own `package.json` and lockfile.
- `plans/` - Design and implementation records for larger features, committed on purpose: the reasoning behind a decision outlives the PR that carried it, and a review that revisits one needs it. Not to be confused with `docs/plans/`, which `.gitignore` drops — those are scratch, these are the record.
- `sample-data/` - Sample knowledge-base data mounted into Docker at `/data/`.
- `marketplace/` - 1-Click deploy templates (DigitalOcean Packer image, CapRover one-click). Version-pinned to the release and guarded by `scripts/lib/marketplace-version.test.mjs` + `marketplace-lint.test.mjs`.
- `docker-compose*.yml` - Development, production, integration, and E2E stack definitions.
- `PERSONALITY.md` - Brand voice guide. Read before writing user-facing UI or docs copy.

## Tech Stack

- Frontend: Next.js 16, React 19, Tailwind CSS v4, shadcn/ui, assistant-ui.
- State: zustand.
- Auth: Better Auth with email/password, database sessions, and admin plugin.
- Database: PostgreSQL 17 with Drizzle ORM.
- Agent runtime: OpenClaw Gateway over WebSocket, via `openclaw-node`.
- Tests: Vitest, React Testing Library, Playwright E2E.
- CI/CD: GitHub Actions, ESLint, Prettier, Husky, lint-staged.
- Security: AES-256-GCM for API key encryption, HMAC-SHA256 audit rows, SBOM generation with Syft.
- Deployment: Docker Compose.
- License: AGPL-3.0.

## Working Principles

- OpenClaw is the runtime. Do not rebuild capabilities OpenClaw already provides; wrap, extend, and govern it.
- Plugin-first: integrations belong in plugins, not hardcoded web-app paths.
- Offline-first and self-hosted: support local models and deployments without internet.
- API-first: every UI action should map to a clear REST/API behavior.
- Enterprise assumptions: features must work for teams, not only a single local user.
- Security and auditability are product features. Treat permission checks, audit records, and secret handling as first-class behavior.
- The website can describe vision. Do not treat marketing pages as proof that a feature exists in code.
- AGPL-3.0 matters. Do not add proprietary or license-incompatible dependencies.

## Development Workflow

- Use TypeScript strict mode and follow existing local patterns before introducing new abstractions.
- Conventional commits are used: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
- Keep changes focused. One feature or fix per PR.
- TDD is the default: write or update the failing test first, then implement.
- Add or update tests for behavior changes.
- Update docs in the same PR when product behavior changes. Smithers reads docs on demand through the `pinchy-docs` plugin, so docs are product context, not decoration.
- Never commit secrets. Assume code, decisions, and progress may be shared publicly.

## No Untracked Test Skips

Permanent test skips need a tracking issue. The ESLint rule `pinchy/no-untracked-skips` and the vitest drift-guard `src/__tests__/lib/no-untracked-skips.test.ts` both enforce this — they fire on `test.skip`, `it.skip`, `describe.skip`, `.todo`, `.fixme`, `xit`, `xdescribe` unless the immediately surrounding 40 lines contain a tracking-issue reference (`#NNN` or a github.com/.../issues/NNN URL) — whether the skip is called directly or hidden behind an alias, see below. A third guard, `no-untracked-skips-parity.test.ts`, pins the two checkers together: if you teach one a new skip syntax and forget the other, the parity fixtures will flag the drift.

Two patterns are explicitly allowed:

- **`describe.skipIf(condition)` / `it.skipIf(condition)`** — conditional gates driven by env vars or OS features (e.g. `describe.skipIf(!process.env.INTEGRATION_TEST)`). These are not "we'll come back to it later" suppressions.
- **Any banned form (`.skip`, `.todo`, `.fixme`, `xit`, `xdescribe`) with `#NNN` in the leading comment block** — the issue is the contract. "Tracked separately" / "follow-up" / inline TODO without a number is not enough. `it.todo("…")` is treated exactly like `.skip` — it silently turns green in CI but never runs, which is precisely the failure mode this policy exists to stop.

If a check is in your way and you can't fix it in scope, **file the issue first**, link the number, then skip. Don't ship the skip with a promise to file the issue later — the 2026-05-22 audit found five clusters where exactly that happened, one of them hiding a production password-reset bug.

### A skip must be called, not aliased

Both checkers matched the **call** form only, so putting the skip behind an identifier made it invisible to both:

```ts
const describeIf = url ? describe : describe.skip; // seen by nothing
describeIf("getSeatUsage", () => { … });
```

Two of these sat in the tree and were found by reading, not by a check (#1071). The conditional spelling above is harmless in effect — it is a gate, and the fix is to write it as one — but the same blind spot swallows `const d = describe.skip`, which is a permanent untracked skip with no condition anywhere near it. That is the case worth a guard.

The ESLint rule now reports a skip that is **referenced rather than called** (`aliasedSkip`), and the drift-guard matches the assignment/ternary form. Same escape hatch as any other skip: a `#NNN` nearby. For a conditional gate, don't reach for the escape hatch — write `describe.skipIf(!url)`. The chained `test.skip.each(...)` is a call, not an alias, and is reported as an ordinary untracked skip.

Two limits are documented rather than closed, because both cost more to catch than they are worth:

- **Aliasing the test object instead of the skip** (`const d = describe;` then `d.skip(...)`) needs scope analysis. Neither checker follows it.
- **The drift-guard's anchor must be on the skip's own line**, so a wrapped `const d =\n  describe.skip;` is missed there. The ESLint rule walks the AST and catches it — the text scan is the weaker of the two by design.

The anchor is not fussiness: an unanchored text match for `test.skip` reports three lines in this repo that are a block comment, a test name and a string literal, one of them untracked — a red CI over prose. Verify a change to either checker by reproduction, not by reading: the fixtures in `no-untracked-skips-parity.test.ts` feed the same snippets through both and fail on any disagreement.

## No Untracked Test Removal

Skips are not the only way a test silently stops protecting you — **deleting** it does too, and the skip guards above cannot see a test that no longer exists. The 2026-06 `é`-dead-key regression shipped exactly this way: a refactor removed two composer composition tests (whole `it()` blocks from a surviving file), nothing flagged it, and the bug returned undetected on the next dependency bump.

The `scripts/check-test-deletions.mjs` CI guard (PR-only, in the `quality` job) closes that gap. It diffs the PR against the base branch, counts test cases (`it`/`test`/`xit`/`fit`, including `.each`) across every changed test file, and **fails if the PR removes tests on net**. Pure logic lives in `scripts/lib/check-test-deletions.mjs` and is covered by `scripts/lib/check-test-deletions.test.mjs` (`pnpm test:scripts`).

Removing tests must be a deliberate, tracked act — same contract as skips. When a removal is legitimate (dead-code cleanup, a deduplicated test, a removed feature), authorize it with **either**:

- a commit trailer referencing an issue: `Allow-test-deletion: #NNN`, **or**
- the `allow-test-deletion` label on the PR.

A bare reason without an issue reference is not enough, exactly as with skips. Moving a test between files is net-zero and never trips the guard. Do not weaken or delete a test to make reduced code pass — a failing test after a refactor signals lost coverage, not a wrong test.

Known limitations (it's a tripwire, not a precise metric):

- It counts test-case calls with a regex, so it does **not** catch a test that is _commented out_ rather than deleted, and it counts `it(`/`test(` that appear inside string literals (including the guard's own fixtures). Review still owns these cases.
- In CI it diffs against the merge-base; if a shallow clone has no merge-base it falls back to a tip-to-tip diff and logs a `::warning::`. A branch far behind the base can then report false removals — rebase on the base (or use the override) if that happens.

## A Released Upgrade Section Is Immutable

`docs/src/content/docs/guides/upgrading.mdx` is cumulative: one `## Upgrading from vA to vB` section per release, newest first. Once vB ships, that section describes vB and nothing else.

It kept not staying that way, and the reason was structural rather than careless. `pnpm release` **froze** the current `%%PINCHY_VERSION%%` section and opened nothing in its place, so the next commit to write an upgrade note appended it to the end of the file — which is the frozen section of the release that already shipped. The note then claims behaviour that release does not have, and re-renders on docs.heypinchy.com under the wrong version. Measured on `main` on 2026-08-01 against `git show <tag>:…`, **seven** released sections had drifted since their tag, four of them by gaining a whole `####` note (#1028).

Nothing saw any of it. The two existing guards cover the neighbouring questions only: `upgrading-mdx-freshness.test.mjs` catches a stale `%%PINCHY_VERSION%%` placeholder, and `upgrade-prune-step.test.ts` (#370) checks the newest section shows `docker image prune`. Neither reads a frozen section's content.

Both halves are now closed:

- **The cause.** `openNextUpgradeSection` (`scripts/lib/release-logic.mjs`) opens the next cycle's section in the release run itself, so the first note after a release always has somewhere correct to land. The skeleton carries `### Breaking changes`, `### Upgrade notes` and the standard-flow bash block — not just headings, because the #370 guard reads the newest section and an empty skeleton would turn the branch red on every release. That completeness costs something: the skeleton satisfies `assertUpgradingSectionExists` by construction, so a release where nobody wrote notes would no longer fail the way it used to (no section at all). `assertUpgradeNotesWritten` is the replacement — it refuses to release a section still byte-identical to the template. Both read `buildNextUpgradeSkeleton`, so the writer and the gate cannot drift apart.
- **The tripwire.** `scripts/lib/upgrading-released-sections.mjs` (+ its test, `pnpm test:scripts`) compares every section whose `to` is a real tag against that section at the tag, and prints which `####` notes were added or removed.

**The skeleton commit lands _after_ `git tag`, deliberately.** The tagged tree is what the docs deploy builds, and `inject-version.sh` resolves every `%%PINCHY_VERSION%%` to the build version — so a skeleton inside the `chore: release vX.Y.Z` commit would publish an empty "Upgrading from vX.Y.Z to vX.Y.Z" section at the top of the live upgrade guide. The branch gets the open section; the tag does not.

Three details worth knowing before editing the guard:

- **A missing tag warns; _every_ tag missing fails in CI.** A guard that hard-fails on one unreadable tag fails on infrastructure instead of on content, so a shallow clone gets a `::warning::`. But zero-of-N is not a soft verdict, it is the guard passing on an empty comparison — and `validateCiWiring` structurally cannot catch it, because it reads what the YAML _says_ rather than what `git show` _answers_. So `emptyCorpusError` fails the run when nothing resolved and `CI` is set, and stays quiet locally where a `--depth=1 --no-tags` clone is a legitimate way to work. `ci.yml`'s `quality` checkout sets `fetch-tags: true` (depth 1 is enough — a shallow-fetched tag still carries its own tree, which is all `git show <tag>:<path>` reads) and `validateCiWiring` fails if that, or the label passthrough, is removed. Verify a change to either by reproduction: `git clone --depth=1 --no-tags` the branch, run the guard with and without `CI=1`, and watch it warn in one and fail in the other.
- **Authorizing an edit is the same contract as a test deletion, with one merge-queue caveat.** A genuine correction to a released section — the v0.5.0 compose snippet that did not work as documented (#281) is the real example — needs an `Allow-upgrade-note-edit: #NNN` commit trailer or the `allow-upgrade-note-edit` PR label. A bare reason is not enough. Deleting a stale `KNOWN_PRE_GUARD_DRIFT` entry is **not** authorizable that way: a verdict must not outlive its evidence. **Prefer the trailer**: a `merge_group` run carries no PR labels (`github.event.pull_request.labels` is empty there), so a label-only authorization is green on the PR and then rejected by the merge queue. The test-deletion guard sidesteps this by running `if: github.event_name == 'pull_request'`; this one lives inside `pnpm test:scripts` and must keep guarding main in the queue, so the failure message names the caveat instead.
- **The baseline is a snapshot, so a rebase can re-open it.** The fingerprints pin `main` as of the moment they were taken. Any commit to `upgrading.mdx` that lands first — including a legitimate one — invalidates the entry it touches, and the guard says so with the new fingerprint. That is the correct behaviour and it is a one-time cost: once this guard is on `main`, such a commit needs its own authorization instead.
- **`KNOWN_PRE_GUARD_DRIFT` pins a body, not a section.** The eight pre-guard drifts are accepted by sha256 of the exact accepted text, so those sections are not left open — the next edit to one of them fails like any other, and the failure prints the new fingerprint. Entries are classified: `retro-correction` (a legitimate fix that predates the trailer, e.g. the `git checkout` → `docker compose pull` rewrite across v0.2.0–v0.4.0) or `misplaced-note` (the bug itself, still to be moved — those must cite a tracking issue).

## No Untracked Sleeps In E2E

Every Playwright config here pins `retries: 0, workers: 1` on purpose: a flake is a signal, not something a rerun hides. A fixed sleep quietly trades that away. It is green on a fast host and red on a loaded runner, and when it does fail it says "timeout" instead of naming what was slow.

That pin is itself guarded now, by `scripts/lib/playwright-config-pins.mjs` (`pnpm test:scripts`). It reads all nine `playwright*.config.ts` files under `packages/web` and requires `retries: 0`, `workers: 1`, and no `fullyParallel: true` — the third because `workers: 1` alone still lets tests _within one file_ race, against a stack that `resetStack()` specs assume is exclusively theirs. `retries` and `fullyParallel` are checked at every nesting depth: Playwright honours a per-project override, so `projects: [{ retries: 3 }]` defeats the top-level pin while leaving it visibly intact.

Two things it does deliberately, both for reasons AGENTS.md keeps re-learning elsewhere:

- **It tokenizes rather than greps.** A first-match regex reads `// retries: 0 — see AGENTS.md` sitting above a real `retries: 2` as compliance, and reads a comment left behind after the pin was _deleted_ as the pin. That is the "reports on the presence of a string" failure again, and the guard's own error messages are what prompt a developer to write that comment. Skipping string literals is not optional either — `baseURL: "http://localhost:7778"` would otherwise start a comment.
- **The walk is recursive, and the corpus check is a cross-reference, not a floor.** A package-root `readdir` — the obvious implementation — misses `packages/web/eval/playwright.eval.config.ts`, a ninth config that CI really runs. So `configsReferencedByScripts` parses `packages/web/package.json` and fails if any config a script invokes was not discovered. A floor of 8 would have stayed green through exactly that gap.

The ESLint rule `pinchy/no-untracked-sleeps` bans `page.waitForTimeout(...)` across `e2e/**` (unit tests in `src/__tests__/eslint/no-untracked-sleeps.test.ts`). Wait on a real signal instead — a web-first assertion, `expect.poll(...)`, `page.waitForURL(...)`, `page.waitForResponse(...)`, or the shared `pollAuditForEvent` / `pollAuditForTool` helpers in `e2e/shared/dispatch-probe.ts`. When you replace a sleep in a retry loop, **the poll's exit condition must be the same condition the final assertion checks** — a weaker "something arrived" exit races the assertion and reintroduces the flake it was meant to remove.

The exemption is the same contract as the skip policy: a comment carrying `#NNN` (or the issue URL). Two differences worth knowing:

- **The comment must sit directly above the sleep's own statement**, with no code in between — not merely "within 40 lines" as with skips. A sleep is one statement and its reason belongs on it. The wide window also does not work here: scanning 40 lines around the two sleeps this rule was written for found `request #2` and `openclaw#42172` in unrelated comments and waved both through.
- **The honest exemption is a bounded negative window** — proving further tokens never arrive, or that no error boundary engaged. There is no event to wait for, so no `waitFor` applies. It still needs an issue, because the deterministic replacement (a signal from the mock that the stream ended, a commit-level counter) is real work, not a fact of nature. The two current exemptions are tracked in #952.

Known limitations, stated plainly:

- **The rule bans the Playwright API, not the concept.** `await new Promise((r) => setTimeout(r, 500))` is the same sleep and is **not** reported — banning it would sweep up ~85 poll-loop intervals across the e2e tree, a separate change with a separate argument. So this is a tripwire against the call a developer reaches for by reflex, not a proof that the suite contains no sleeps. Writing the `setTimeout` form to dodge the rule is a deliberate act, and review owns that case.
- **The scope is `packages/web/e2e/**` — every Playwright `testDir` in the repo, and nothing else.** Two `waitForTimeout` users sit outside it deliberately: `screenshots/capture.ts` (a capture script — a sleep there yields an ugly screenshot, never a false green) and the poll interval in `packages/web/eval/run-eval.ts` (a measurement harness, and a poll interval besides). Adding a Playwright `testDir` outside `e2e/` would escape the rule; extend the `files:` glob in `packages/web/eslint.config.mjs` if that ever happens.

## Test Migrations Against Pre-Existing Data

When you change **where a feature reads its data from** — a new table, a new store, a different source (e.g. the Telegram mirror switching from OpenClaw `chat.history` to Pinchy's `channel_messages`) — you MUST add a test that reads data written by the **old** source with the **new** code.

This is the read-side sibling of the test-skip/test-deletion guards: it forces a conscious decision about migration (backfill, fallback, or accept-and-document) instead of silently dropping data created before the switch.

The trap is that every test starts from a clean slate where the new mechanism is live from the first write, so a green suite proves nothing about the state a real **upgrade** produces (old data, new code). The 2026-06 Telegram regression shipped exactly this way: the source switch blanked every conversation that predated the capture plugin, and the existing Telegram E2E stayed green because it only ever exercised freshly-captured conversations.

Concretely:

- **Simulate the pre-existing state:** let the new path capture/write, then delete those rows for the entity, then assert the feature still works (it must fall back or have been backfilled). See `deleteCapturedTelegramMessages` + the "listed ⟹ readable" test in `packages/web/e2e/telegram/chats.spec.ts`, and the deterministic route-level equivalent in `packages/web/src/__tests__/api/agent-telegram-chat.test.ts`.
- **Assert the cross-route invariant**, not just one route in isolation: if an item appears in a list, opening it must show content (or a defined, honest empty state). List and detail are often changed independently.

## No Unread Catastrophic Eval Cell

The Eval-v1 dataset (`packages/web/eval/data`) is committed evidence, and evidence nobody reads protects nobody. The 2026-07-11 sweep measured `minimax-m3` at 0/12 on the line-items scenario — the only one that needs nested-array tool arguments. Four days later a production agent failed to book invoices on that model, for that defect (#766). The number was in the repo the whole time; nothing wired it to `model-resolver/blocklist.ts`.

`packages/web/eval/__tests__/scorecard-triage-guard.test.ts` is the wire. It runs in vitest against the checked-in dataset (~2s, no docker stack, no API keys — `pnpm -C packages/web eval:models` needs both, and CI runs only `eval:selftest`), so it gates every PR, including the one that commits a fresh sweep. It judges the **published** numbers, via `buildPublishedScenarios()` from `eval/export-scorecard.ts` — not the stored `data/<scenario>.json` scorecards, which three re-graded scenarios have since diverged from.

It flags a cell where a **capable** model passed **zero** of at least 8 valid runs — capable meaning a median pass rate ≥ 0.5 across the _other_ capability scenarios. That anchor is load-bearing: a weak model's zero is not information (weak models even _pass_ some failure scenarios by incapacity, see `eval/data/README.md`), and flagging them would bury the signal. Every flagged cell needs a committed verdict in `packages/web/eval/triage-ledger.ts`:

- **`blocked`** — `blocklist.ts` names the model, and the guard asserts the rule really exists for the capabilities the entry claims.
- **`accepted`** — you looked and concluded it is not blocklist material, with the reason written down.

Both drift directions fail: a flagged cell with no entry, and an entry whose cell no longer flags (a verdict must not outlive its evidence).

**A flag is a reason to look, never a reason to block.** The eval grades outcomes — it re-reads Odoo state after a run and never inspects a tool-call payload — so it can ground a suspicion, not a cause. Do not turn the threshold into a blocklist generator: of the four cells flagged today only one is a tool defect; the others are a judgement defect (`gemma4:31b` duplicates blindly) and honesty defects (`false-success`). Those are handled by ranking and by the methodology, not by a denylist. The blocklist stays evidence-based: what it does not name is allowed.

## CI Path Filtering Is Job-Level, Never Workflow-Level

`.github/workflows/ci.yml` must **never** carry `paths-ignore:` (or `paths:`) on its triggers. It hosts main's required status checks, and a workflow that never starts never reports a status — so a docs-only PR would sit forever on "Expected — Waiting for status to be reported": unmergeable, with nothing actually broken. This is exactly what the old `paths-ignore: [docs/**, "**/*.md", ...]` did once those checks became required.

The filter now lives one level down:

- The **`changes` job** diffs the PR against its base and outputs `code=true|false` via `scripts/detect-code-changes.mjs`. Pure logic is in `scripts/lib/ci-path-filter.mjs` (`hasCodeChanges`), covered by `scripts/lib/ci-path-filter.test.mjs` (`pnpm test:scripts`).
- **Ungated jobs** are listed in `UNGATED_JOBS` with the reason each one carries no gate. Two distinct reasons — don't conflate them:
  - `required` (`quality`, `vitest-integration`, `e2e` — the names in branch protection, exposed as `REQUIRED_JOBS`): they must report on every PR, so no required check depends on GitHub's subtle "a skipped job counts as success" behaviour.
  - `docs-relevant` (`links`): the job guards exactly the files a docs-only PR consists of (`**/*.md`), so gating it would skip the check on precisely the PRs that need it. Only worth it for cheap jobs.
- **Every other job** carries `needs: changes` + `if: needs.changes.outputs.code == 'true'`, which is where the CI-minute saving comes from. A gated job is genuinely skipped on a docs-only PR.

Mistakes the drift guards in `ci-path-filter.test.mjs` exist to catch: re-adding `paths-ignore` (the original bug); adding a new job without the gate (it would silently run the full Docker/E2E matrix on every README typo); an `UNGATED_JOBS` entry that is actually gated in `ci.yml` (a list that lies); and a lockfile `vuln-scan` reads that the filter treats as docs.

**Ignoring a path is a claim that no gated job reads it.** `docs/**` is prose with one carve-out: `docs/pnpm-lock.yaml` counts as **code**, because `vuln-scan` scans it — classifying a docs-lockfile security bump as docs-only would skip the very scan that proves the fix and leave main red until someone hand-ran `workflow_dispatch`. Before adding an ignore rule, check which gated job reads those files.

An unresolvable base or empty diff deliberately answers **`code=true`**: wasting CI minutes is recoverable, skipping the matrix on a real code change is not. When adding a job that depends on `build-image`, note that `build-image` is skipped both on fork PRs (fall back to a local build) and on docs-only PRs (build nothing) — only the explicit `changes` gate tells those two apart.

## Never Put A Required Check In A Matrix

A `strategy.matrix` renames a job's status check: `E2E Tests` becomes `E2E Tests (1/2)`. Branch protection matches checks **by name**, so the moment a required job grows a matrix, main waits forever on a name that will never report again — the same unmergeable-with-nothing-broken failure as a workflow-level `paths-ignore`, from the other direction.

The required names are `quality`, `vitest-integration` and `e2e` (`REQUIRED_JOBS` in `scripts/lib/ci-path-filter.mjs`). Sharding any of them means changing branch protection in the same change — **ask first**, it is not a unilateral edit. Every other job is free to shard.

Sharding is worth it only where test time clearly exceeds the **~4m30 fixed overhead** every E2E job re-pays per shard (image pull ~1m30, stack boot ~1m, pnpm/playwright setup, teardown). Today that is `setup-wizard-e2e` (8m22) and `integration` (8m17); `telegram-e2e` (5m19), `odoo-e2e` (4m24) and `email-e2e` (3m32) stay whole, because a second stack would cost more than it saves. Measure before adding a shard — `gh api repos/heypinchy/pinchy/actions/runs/<id>/jobs` gives per-step timings.

Two things a shard must get right:

- **Shard across jobs, never by raising `workers`.** Every Playwright config here pins `workers: 1` deliberately: setup-wizard's specs call `resetStack()` (truncates the DB, restarts containers) and the integration suite shares one OpenClaw session. Two specs in one stack would wipe each other's state. One stack per shard keeps that invariant; `fullyParallel: true` breaks it.
- **Scope the diagnostics artifact to the shard.** `upload-artifact` rejects a duplicate name within a run, so a bare `artifact-name: "<suite>"` from both shards turns a real test failure into an upload error and loses the diagnostics.

Related: the images are built by a `build-images` **matrix** (two runners, ~2× faster than the old serial job) and fanned back in through `build-image`, whose only job is to preserve the `result` + `outputs` contract the 11 downstream jobs already encode. Its `if:` mirrors the matrix's verbatim, and `!cancelled()` plus its guard step is what keeps a _failed_ build from reading as `skipped` — which downstream would take as "fork PR, build locally" and cheerfully rebuild a Dockerfile CI just proved broken. Because a matrix cannot export per-entry outputs, the fan-in recomputes the tags; `scripts/lib/ci-image-tags.test.mjs` pins the two expressions together.

## A Red Playwright Job Must Leave Something Behind

Nine jobs in `ci.yml` run Playwright. Eight got the `capture-e2e-diagnostics` composite action; the ninth — `e2e`, the **required** check, the one whose flakes actually block merges — was the one nobody came back to, so a red required check gave only the list reporter's terse text (#1061). The suite hardest to diagnose was the suite that most needed diagnosing.

Two claims have to hold, and each is invisible when it stops holding:

- **The job uploads Playwright's output when it goes red.** Either `capture-e2e-diagnostics` (docker-compose stacks — it also collects container logs and a secret-redacted `openclaw.json`) or a plain `actions/upload-artifact` for `packages/web/test-results/`. The `e2e` job takes the second route deliberately: it runs Playwright's own `webServer` against a bare Postgres service container, so a synthetic `compose-files` would upload four log files describing a stack that never started. **The step needs an `if:` that survives failure** — one without it runs only on success, so the artifact never appears for the failures it exists for, and nothing is red.
- **The config asked Playwright to write that output.** `playwright.integration.config.ts` set `trace` but not `screenshot`, so the composite action advertised a bundle containing "Playwright traces, screenshots, and full container logs" and shipped one with no screenshots for that suite. Uploading the right directory and filling it are separate claims; CI can only ever observe the first.

`scripts/lib/e2e-diagnostics-coverage.mjs` (+ its test, `pnpm test:scripts`) pins both, over the real `ci.yml` and the real configs, with a corpus floor so a broken sweep cannot pass on an empty comparison. A job whose steps it cannot read **throws** rather than reporting "no offenders" — a clean verdict on unreadable input is how a guard stops guarding the moment somebody reindents a job.

Two things worth knowing before editing it:

- **The upload path is one directory for every config, including the nested one.** Playwright's default `outputDir` is `path.join(packageJsonDir, 'test-results')` — the nearest **package.json**'s directory, not the config's. `packages/web/eval/` has no package.json, so `eval/playwright.eval.config.ts` writes to `packages/web/test-results/` like all the others. Verify a change to this by reproduction, not by reading the config: the resolution rule is neither "relative to the config" nor "relative to cwd", and guessing either way gets it wrong.
- **It is a tripwire, not a proof that a failure is diagnosable.** `trace: "on-first-retry"` is a legitimate value that captures nothing here, because every config pins `retries: 0` on purpose (§ "No Untracked Sleeps In E2E" — a flake is a signal). The guard would not notice. Review still owns that case.

## Every Job Sets `timeout-minutes` — Except The Ones That Must Not

GitHub's default job timeout is **360 minutes**, and until this guard landed no job in any of the ten workflow files set one. A hung `docker compose up`, a stuck poll loop or a wedged `docker compose pull` therefore tied up a runner for six hours instead of failing fast — and everything queued behind it, including a merge-queue run waiting on a required check, waited the same six hours.

`scripts/lib/workflow-timeouts.mjs` + its test (`pnpm test:scripts`) require a job-level `timeout-minutes` on **every** job in **every** workflow — including the cron-only ones (issue-triage, docs-freshness, sbom, prune-ghcr), because a hang nobody is watching is the one that goes unnoticed longest — with a 10-minute floor.

**The exception is why the guard checks both directions.** A job that calls a reusable workflow (`uses:` at the job's own indent) accepts only `name`/`uses`/`with`/`secrets`/`needs`/`if`/`permissions`. A `timeout-minutes` there is not ignored, and does not fail just that job: GitHub refuses to parse the **whole file**, the run ends in seconds with no jobs, and no status is ever reported. On `ci.yml` that is every required check silently never arriving — the same unmergeable-with-nothing-broken failure as a workflow-level `paths-ignore`, reached from a third direction. The first draft of this very change shipped it on `vuln-scan` and `release.yml`'s `docs`, and both CI and Release died at 0s. So such a job is **exempt from needing** a timeout and **rejected for having** one; its timeout belongs on the called workflow's own jobs (`screenshots.yml` sets its own; a third-party reusable workflow's are not ours to set).

**Size a timeout from measured runs, not from a guess.** `gh api repos/heypinchy/pinchy/actions/runs/<id>/jobs` gives per-job durations; the rule here is at least **2× the max across recent green runs**. The asymmetry is the argument: a too-generous cap costs nothing until something actually hangs, while a too-tight one turns a healthy run red on a repo whose Playwright configs pin `retries: 0` precisely so that a red run means something. Watch the Docker image builds — their cost is registry throughput and buildx cache hits rather than work done, so they are bimodal: `pre-release` alone spans 10m to 37m across ten green runs, and a 25-minute cap would have cancelled a build that really did succeed.

`actionlint` reports the reusable-workflow mistake in about a second with the exact allowed-keys list. It is not wired into CI, so run it locally after editing a workflow — the regex guard here encodes one known trap, not GitHub's whole schema.

## Embeddable Serving Routes Need A next.config Entry

A header set by a route handler **loses** to `next.config.ts`'s `headers()`. The global `/(.*)` rule sets `X-Frame-Options: DENY`, so a file-serving route that sets `x-frame-options: SAMEORIGIN` in its own response still gets DENY on the wire: a valid `200 application/pdf` that the browser refuses to render, `net::ERR_BLOCKED_BY_RESPONSE`, blank viewer pane. It shipped twice this way — the KB citation viewer and agent-delivered artifacts (#703 / #788) — and every test was green both times, because route tests assert the header the **handler** declares.

So a route that serves embeddable content needs **two** things, and `packages/web/src/__tests__/security/frame-options-route-coverage.test.ts` fails CI when they drift apart:

- the handler's own `x-frame-options: SAMEORIGIN` (directly, or via `streamWorkspaceFile`), and
- a `{ source, headers: [{ key: "X-Frame-Options", value: "SAMEORIGIN" }] }` entry in `next.config.ts`, written **after** the catch-all — later rules win.

The guard derives the expected `source` from the route's file path and prints the exact line to add. It checks both directions: a serving route without an entry, and an entry without a serving route (a relaxation must not outlive its route, nor be widened to one that renders HTML). `resolveHeader`/`matchesSource` in `packages/web/src/test-helpers/next-headers.ts` model Next.js's resolution for a concrete path; they throw on `has`/`missing` rather than guess.

**The general lesson: assert the value a concrete URL resolves to, not the value a handler asked for.** The two are different questions, and only one of them is what the user's browser gets.

## `/api/internal/` Is A Security Claim, Not A Folder Name

Two gates in `packages/web/server.ts` wave the whole prefix through: the domain-lock host check (`src/server/host-check.ts`) and the CSRF gate (`src/server/csrf-check.ts`). Both do it for the same reason — a route under `/api/internal/` is bearer-token traffic from an OpenClaw plugin, arriving on a Docker-internal hostname (`pinchy:7777`) that can never match the locked public domain, with no browser anywhere in the picture.

The host check used to spell that out as a hand-written list of individual paths, and it drifted exactly the way § "A Hand-Maintained List That Mirrors Code Will Be Wrong" predicts. `/api/internal/channel-messages` was never added, so on any domain-locked install every capture POST from `pinchy-transcript` was answered `403 Forbidden: request host does not match the configured domain`. Pinchy's owned transcript — the whole point of the feature — stayed **empty in production for eleven weeks** (#599), and forensics for an unrelated incident had to fall back to `audit_log`, which stores tool params and no results. `knowledge/search` and `report-auth-failure` were missing from the list too, and would have failed the same way the moment anyone used them under a lock.

Nothing was red. The E2E stacks configure no domain, so `getCachedDomain()` returns null and the entire host check is inert — a gate that is switched off in every test cannot fail in one.

So the list is gone; the prefix itself is the rule. What that buys is worth stating plainly: a new internal plugin route is exempt the moment it exists, and there is no second place to remember. What it costs is that the prefix now has to mean what it says, which is what `packages/web/src/__tests__/security/internal-routes-gateway-auth.test.ts` enforces — every route under `app/api/internal/` calls `validateGatewayToken`, or is named in host-check's `LOOPBACK_ONLY_EXEMPT_PATHS` (today: the unauthenticated OpenClaw readiness probe, exempt for same-container loopback only).

That guard is not decoration: `POST /api/internal/audit/background-run` was a **session-authed browser** route sitting under the prefix, silently inheriting both exemptions — the CSRF one let a cross-site POST forge a `chat.background_run_completed` audit row using the visitor's own session. It moved to `/api/audit/background-run`. Put a session-authed route anywhere but here.

Two smaller rules that fall out of the same incident:

- **A rejected request must leave a trace on the Pinchy side.** The 403 was invisible to everyone but whoever read the OpenClaw container's stdout. A blocked `/api/` request now writes an `auth.host_blocked` audit row (`logHostBlocked`), mirroring the CSRF gate's `auth.csrf_blocked`. Page requests are deliberately **not** audited — a locked instance answers every crawler that finds its IP, and those rows would bury the one that matters.
- **An audit row an anonymous caller can mint needs a bound.** This is the one event a plain unauthenticated `GET` triggers — a locked instance is by definition reachable at an address that isn't its domain — and every `appendAuditLog` takes `pg_advisory_xact_lock` on one constant key, so an unbounded stream serializes _every_ audit write in the process behind itself. Same shape as `auth.scope_denied` (`claimScopeDenialSlot`, lib/api-auth.ts): one row per minute, `suppressedSinceLastEntry` carrying the volume. The window is **global, not keyed** — host, path and remote address are all caller-supplied, so a map keyed on one of them grows per request and the throttle stops throttling. `scopeDenialWindows` may key by API key only because an admin has to mint one first.
- **Two gates reading one header must read it the same way.** `readRequestHost` (`src/server/forwarded-host.ts`) is that one reading. The CSRF gate folded a multi-hop `X-Forwarded-Host` to its public first hop; the domain lock compared the whole string. A CDN in front of Caddy therefore passed one gate and was answered 403 by the other — #599's failure shape, one layer in. `__tests__/middleware/forwarded-host.test.ts` asserts the cross-gate invariant, not just each gate alone.
- **When a client gives up on a response, it must say why.** The plugin logged `capture rejected (403)` and dropped the message, while the body it already held said the domain lock had refused the Host header. Quote the body.

## Web Test Files Are Type-Checked

`packages/web` test files (`*.test.ts(x)`, `*.integration.test.ts`, `*.test-d.ts`) are type-checked in CI by the `quality` job's "Typecheck web (incl. tests)" step: `pnpm -C packages/web typecheck` → `tsc --noEmit -p packages/web/tsconfig.typecheck.json`.

This exists because `next build` type-checks the web package but its `tsconfig.json` deliberately **excludes** `src/**/*.test.ts(x)`, and vitest runs without `--typecheck`. So test-file type errors — including dormant `expectTypeOf`/`assertType` assertions that silently pass as runtime no-ops — went undetected until this gate landed. `tsconfig.typecheck.json` extends the base config but INCLUDES the test files and adds `vitest/globals` + `@testing-library/jest-dom` to `types`.

- Write genuine type-level tests: `expectTypeOf(...).toEqualTypeOf<T>()` / `.toExtend<T>()` are now real compile-time checks. Do NOT paper over failures with `as any` / `@ts-expect-error`.
- Shared, correctly-typed test helpers live in `packages/web/src/test-helpers/` (`auth.ts` → `mockSession`, `route.ts` → `makeNextRequest`/`routeContext`, `fixtures.ts` → `makeAgent`/`makeTemplateItem`). Prefer them over inline fixtures so a type change is a one-line helper fix, not a sweep across test files.
- The drift guard `scripts/lib/web-typecheck-gate.test.mjs` (pure logic in `web-typecheck-gate.mjs`, run by `pnpm test:scripts`) fails if the tsconfig stops including test files, re-excludes them, the `typecheck` script drifts, or CI stops running the gate — the read-side sibling of the no-untracked-skips / no-test-deletion / plugin-typecheck guards.
- Playwright `e2e/**/*.spec.ts` is intentionally out of this gate (separate Playwright type context).

## Tests Run In Node; jsdom Is Opt-In Per File

`packages/web/vitest.config.ts` sets `environment: "node"`. A test that needs a DOM declares it itself, as the **first line of the file**:

```ts
// @vitest-environment jsdom
```

Building and tearing down a jsdom is charged per test **file**, and most files here never touch a DOM: 155 of 714 web test files declare jsdom, so under the old global `environment: "jsdom"` roughly 78% paid for a browser they never opened. Measured back-to-back on one directory (87 files under `src/__tests__/api`, same machine, same load): **326.3s with a global jsdom against 151.0s with node**, with the environment bucket collapsing from 1805s summed across workers to 96ms. Every agent paid that on every verification.

- **No drift guard, deliberately.** A file that needs a DOM and forgets the docblock fails immediately and unmissably with `document is not defined`. A guard would only duplicate a failure that already cannot be missed.
- **The one case that does NOT fail loudly is feature-detected code**, and the empirical method used to pick these 155 files (flip the default, run the suite, mark what fails) cannot see it. A module guarded by `typeof window !== "undefined"` / `typeof navigator !== "undefined"` simply takes its non-browser branch in node and the test passes — against the other path. Node also _has_ a `navigator`, so even a `typeof` probe is not a reliable browser check: `src/lib/github-issue.ts` stamps `- Browser: ${navigator.userAgent}` into a bug report, and `__tests__/lib/github-issue.test.ts` now exercises that with `Node.js/22` in the field, asserting only that the label is present. Nothing is broken, but the test proves less than it reads as proving. When a test's subject branches on the environment, give the file the docblock — that is not speculative, it is the branch under test.
- **The docblock must precede the imports.** Vitest reads it from the file's leading comment block; a `// @vitest-environment jsdom` sitting below an import is silently ignored and the file runs in node.
- **Do not add the docblock speculatively.** It is not free — it is exactly the cost this change removed. Add it when a test fails without it.
- Plugin tests under `packages/plugins/pinchy-*` run through this same config and were already node-only; most already carry `// @vitest-environment node`, which is now redundant but harmless.

Related: `testTimeout` is 20s and `hookTimeout` 40s, not vitest's 5s/10s defaults. The defaults left no headroom, and on a busy machine failures appeared scattered across _unrelated_ files — `enterprise-banner`, `chat-switcher`, `auth-http-config`, `knowledge-reindex-section` — all timeout-shaped rather than genuinely broken. That is a suite-wide lack of slack, not a set of individual flakes; each one cost an agent a full re-run to rule out. Not guesswork: single React component tests here measure 10.5s and 13.7s _in isolation_ on a loaded machine, so 5s was a guaranteed failure. A genuinely hanging test still fails, 20s later. **Headroom is not a weakened gate** — but if a specific test needs _minutes_, give that suite its own explicit `{ timeout: … }` and say why, as `pdf-extract.test.ts` does.

## The Pre-Push Build Runs On Relevance, Not On Every Push

`.husky/pre-push` still runs the real `pnpm build`. That is not negotiable: `next build` is the **only** check in the local loop that sees the Next.js client/server bundling boundary. A shared lib module imported by a Client Component must not transitively pull in `@/db` / `postgres` / `@/lib/settings`; when it does, the DB driver lands in the client bundle and the build fails with "module not found". `tsc --noEmit` checks types, not bundling, and vitest resolves `postgres` in Node without complaint — both stay green while the app does not build. That has shipped here before.

What changed is _when_ it runs. It was the single largest per-iteration cost in the whole loop (>5 min under load, enough to blow a 5-minute tool timeout), and it ran on docs-only and test-only pushes too. `scripts/should-run-prepush-build.mjs` now reads git's pre-push stdin protocol for the exact pushed range and skips the build for two — and only two — reasons:

1. **Nothing in the diff reaches the build.** Decided by `isBuildIrrelevant` in `scripts/lib/prepush-build-gate.mjs`. Worth ~1 commit in 40 on its own.
2. **The build input is byte-identical to one that already built successfully in this worktree.** `buildInputFingerprint` hashes every build-relevant blob; `.husky/pre-push` records it via `--record` only after `pnpm build` exits 0, into the worktree's own git dir. This is where the real saving is: amend/rebase cycles, a follow-up docs commit, a test-only fix after review — all move the tree but not the build's input.

Rules for touching this:

- **Fail open, everywhere.** No stdin, an unresolvable range, a git error, a crash in the gate — every one of them builds. The hook builds on any output that is not exactly `skip`.
- **The exclusion set is pinned to `packages/web/tsconfig.json`, not to intuition.** `next build` type-checks everything that tsconfig includes (`**/*.ts(x)` under `packages/web`) minus its `exclude` list. So `src/**/*.test.ts(x)` is safe to skip, but `e2e/**`, `eval/**` and `src/test-helpers/**` are **not** — they are inside the include and a type error in them really does fail the build. `prepush-build-gate.test.mjs` reads the tsconfig and fails if that pairing drifts.
- **tsconfig says which files are checked, not where they may reach.** A relative import climbs out of `packages/web` and drags its target into the build graph regardless of any include glob: `src/lib/openclaw-config/plugin-manifest-loader.ts` statically imports all nine `packages/plugins/pinchy-*/openclaw.plugin.json` manifests, so a malformed manifest — or one that loses a field the loader reads — really does fail `next build`. "`packages/plugins/` never reaches the build" was true of the plugin **source** and false of the **manifests**, and the gate skipped for both. `BUILD_RELEVANT_OUTSIDE_WEB` is the carve-out; do not extend it by hand. `escapingImportTargets` plus its drift guard derive every escaping import from the source and fail until the target is classified, so the next `import … from "../../../../plugins/…"` cannot land in the build graph unnoticed. Verify a change to that guard with a canary (add such an import, watch the test go red, remove it) — reading the code is what missed the manifests in the first place.
- The guard reads the forms TypeScript **resolves** (`from`, side-effect `import`, `import()`, `import x = require()`), not a bare `require()`. `eval/__tests__/odoo-mock-eval-reset.test.ts` loads the odoo mock through `createRequire` with a cast, which is a runtime dependency `next build` never reads — reporting it would demand a build for a file the build cannot see.
- **`pnpm build || exit 1`, then `--record`.** The record step runs last, so without the explicit `|| exit 1` a broken build would become a green push.
- Adding a path to the irrelevant set is a claim that `next build` cannot read it. Check before claiming — the same discipline as the CI path filter above.

## One Format Gate, Whole-Tree, From The Root

There is exactly **one** format gate: `pnpm format:check` → `prettier --check .`, run from the repo root by the `quality` job. `pnpm format` writes. Prettier is declared **once**, in the root `package.json`, and nowhere else.

Until 2026-07 the gate was `pnpm --filter @pinchy/web format:check` — a check named "Format check" that only ever read `packages/web`. Everything else had never been formatted and nothing said so: `scripts/` (28 files), every plugin (56), the `config/` mock servers, the compose overlays, `docs/scripts/`. **The check was green the whole time**, because a gate reports on what it looks at, not on what it should look at. That is the same failure shape as a `paths-ignore` on a required check, arriving through the config instead of the trigger.

The rules that keep it honest:

- **Whole-tree (`.`), never a glob list, never `--filter`/`-C` delegation.** Both narrow the gate silently, and both are the original bug spelled differently. What is excluded belongs in `.gitignore`/`.prettierignore` — one place, not a list in a script that rots as directories are added.
- **`.prettierignore` must repeat what NESTED `.gitignore` files say.** Prettier reads only the **root** `.gitignore`; `docs/.gitignore` and `packages/web/.gitignore` are invisible to a run started from the root. Add a generated directory to a nested `.gitignore` → add it to `.prettierignore` too, or `pnpm format` reformats build output.
- **One prettier declaration.** Two can resolve to two versions, which format the same file differently — then somebody's local `pnpm format` always loses to the gate.
- **`pnpm format` is not guaranteed to converge in one pass.** Prettier is not idempotent on every input (`config/llm-providers-mock/server.js` reflows a method chain differently on pass 1 and pass 2). The tree is committed at a fixed point; if `format:check` still complains right after `format`, run `format` again before assuming the gate is broken.
- **A green `format:check` does not prove the tree is what `pnpm format` would produce.** Prettier's output is path-dependent: an object literal that already has a newline after `{` stays expanded, so a break introduced by an earlier run at a different `printWidth` survives every later run — and `--check` passes on **both** shapes, which is precisely why CI cannot see the difference. Re-formatting an already-formatted tree therefore preserves the old config's decisions instead of replacing them. This is not hypothetical: the commit that first brought the tree into this gate shipped that way once, with the plugins carrying breaks from a pass that ran while `.prettierrc` still sat in `packages/web/` (printWidth 80), and three files rewritten that printWidth 100 asks no change of. **Re-format from the pre-format tree in one pass**, and verify by reproduction — format each file from the parent commit's blob and compare to the committed one — never by the gate being green.
- The drift guard is `scripts/lib/format-gate.test.mjs` (pure logic in `format-gate.mjs`, run by `pnpm test:scripts`). Its most important assertion is not the wiring but the **coverage probe**: it resolves prettier's real ignore rules against one file per tree and fails if any is excluded. A single well-meaning `scripts/` line in `.prettierignore` reverts the whole gate while every check stays green — that is the one mutation the wiring checks cannot see.

### Two styles, and why the boundary sits at `packages/`

There is deliberately **no root `.prettierrc`**. `packages/.prettierrc` (printWidth 100, `trailingComma: es5`) governs **all** app TypeScript — `packages/web` **and** `packages/plugins/*`. Everything else — `scripts/`, `config/`, `docs/`, the compose files, `.github/` — uses prettier's defaults (printWidth 80, `trailingComma: all`), which is what those files were already written in. This is a **coverage** gate, not a style-unification: a root config in the web style would re-wrap 23 files that are green today, which is a separate change with a separate argument.

The config sits at `packages/`, not `packages/web/`, and that is load-bearing rather than tidiness. `normalizeTableHtml` is **duplicated on purpose** across `packages/plugins/pinchy-files/docx-extract.ts` and `packages/web/src/hooks/use-ws-runtime.ts` (bundle isolation), and `normalize-docx-table-html-drift.test.ts` pins the two bodies to be textually identical modulo whitespace and comments. With the config one level down, the plugin copy formatted at `trailingComma: all` and the web copy at `es5` — a **token** difference, not a whitespace one, so the guard went red the moment the plugins entered the gate. Any style split that cuts through duplicated-by-design code will do that again. If a future duplication crosses a different boundary, move the config up — do not weaken the guard. Re-read the path-dependence bullet above before you do: moving the config is exactly the operation that leaves the tree formatted by the config you just replaced, while every check stays green.

`docs-format.yml` used to check docs and workflows separately, because `ci.yml` once carried a workflow-level `paths-ignore` and skipped docs PRs. It no longer does (see above), and `quality` is ungated — so the root gate covers those files on every PR and the extra workflow was removed rather than left to duplicate it.

### The pre-commit hook invokes its binaries directly

The same gate runs locally through `.husky/pre-commit` → lint-staged, and there the **whole-tree rule must invoke its binary directly** (`prettier --write --ignore-unknown`), never through `pnpm exec` / `npx` / `pnpm -C … exec`. lint-staged puts every ancestor `node_modules/.bin` on `PATH`, and the worktrees live under the main checkout (`.claude/worktrees/…`), so a bare binary resolves from a worktree by walking up to the main checkout's install. `pnpm exec` ignores that PATH and resolves through the workspace it finds instead — and a worktree root **is** a workspace root (`pnpm-workspace.yaml`) with no `node_modules`, so the exec goes recursive over the workspace packages and dies with `ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL`. The failure keys on the workspace root, not on the missing `node_modules` as such: `pnpm -C <dir> exec` from a **non**-workspace directory does reach the ancestor install, which is why the wrapper looks harmless when tried anywhere but where the hook runs. Wrapping the rule trades a rare stale-install failure for a failure on **every** worktree commit (#838 proposed exactly that wrapper; the reported ENOENT was a stale `node_modules` — prettier became a root devDependency only in `9fd765023`, so an older install never linked the bin).

Why this matters beyond formatting: when lint-staged cannot run, committers reach for `--no-verify`, and that skips the _whole_ hook — the drizzle-snapshot check and the absolute-path guard included. So a formatter that is merely not installed silently disables two integrity checks. `scripts/check-precommit-tooling.mjs` runs before lint-staged and turns that into one actionable line (`pnpm install`) instead of a bare ENOENT.

The drift guard is `scripts/lib/precommit-tooling.test.mjs` (pure logic in `precommit-tooling.mjs`, run by `pnpm test:scripts`). As with the format gate, the wiring assertions are the cheap half; the load-bearing one is the **execution probe**, which resolves and runs the configured command exactly as lint-staged would, from a directory with no `node_modules` of its own, on a file outside `packages/web/src` — the case every packages/web-scoped check is blind to.

The `packages/web/src/**/*.{ts,tsx}` eslint rule _is_ wrapped, correctly: its binary lives in that package, and eslint genuinely cannot run from an uninstalled worktree anyway (its flat config resolves plugins from `packages/web/node_modules`). Unwrapping it would move the failure, not remove it. But a scoped rule runs only for the files it matches, so blocking on it up front would reject a docs commit over a binary it never invokes — hence the split: the preflight blocks only on what runs on **every** commit, and `--explain` runs **after** a lint-staged failure to name a missing per-package binary as `pnpm install` rather than leaving it to read as a lint error.

## Two Scanners, One Acceptance

A vulnerability can be accepted in two places, and they read different files. `osv-scanner.toml` feeds CI's `vuln-scan` job; `pnpm.auditConfig.ignoreGhsas` in the root `package.json` feeds `pnpm audit --audit-level=high --prod`, the gate `scripts/release.mjs` runs before a tag is cut. **`pnpm audit` does not read `osv-scanner.toml`.** GHSA-mh99-v99m-4gvg was triaged and accepted in #914 and told only to osv-scanner, so v0.9.0 could not be cut over an advisory the repo had already accepted — the acceptance sat on record in a place the release path never consults (#993).

`scripts/lib/audit-ignore-parity.test.mjs` (pure logic in `audit-ignore-parity.mjs`, run by `pnpm test:scripts`) enforces the pairing. Every id in `ignoreGhsas` must have an `[[IgnoredVulns]]` entry with a `reason` and a **non-expired** `ignoreUntil`.

- **The expiry rule is the load-bearing one.** `ignoreGhsas` is a bare array of ids — no reason, no expiry, and pnpm offers no `ignoreUntil`. So on the expiry date osv-scanner re-opens the question and `pnpm audit` structurally cannot; the two configs diverge by construction, with the _release_ path the silent one. The guard is how the pnpm-side silence inherits the deadline written next to the rationale.
- **The check is one-directional on purpose** — `ignoreGhsas` ⊆ osv ids, never the reverse. Most entries here are things `pnpm audit --prod` at the root cannot see anyway (the astro advisories live in `docs/pnpm-lock.yaml`; the openclaw one is a devDependency). Mirroring those would silence a scanner about findings it never emits.
- **The `reason` is the machine-readable record; the TOML comment above it is not.** osv-scanner prints `reason` and nothing else, so a route named only in the comment is not named at all — an acceptance that does not name a path it accepts is not an acceptance of that path.

## One Node Version, Stated In Four Kinds Of Place That Must Agree

Node is pinned in `.nvmrc` (`22`) and `engines.node` (`>=22 <23`); CI's `node-version:` and every Dockerfile's `FROM …node:<major>` must name the same major. `scripts/lib/node-version-pin.test.mjs` (pure logic in `node-version-pin.mjs`, run by `pnpm test:scripts`) fails if any of them drifts.

Until 2026-07 only CI said a version. A local Node could be anything, and nothing anywhere mentioned it — until a **native** module noticed, which is where this gets expensive. On Node v25.2.1 against a `better-sqlite3` built for Node 22, every `pinchy_read PDF integration` test failed like this:

```
AssertionError: expected 'The module …/better_sqlite3.node was compiled against a
different Node.js version using NODE_MODULE_VERSION 137. This version of Node.js
requires NODE_MODULE_VERSION 141.' to contain '<document>'
```

Read the shape, not just the text: `pinchy-files` returns the module loader's error as the tool's **result** rather than throwing, so an environment fault arrives as an ordinary assertion failure **on a product assertion**. Nothing says "rebuild your native modules". The honest reading is "the PDF path is broken", and the hours go into code that is fine (pinchy#947).

**The Dockerfiles are the place it is tempting to forget and the worst one to get wrong.** `better-sqlite3` is compiled _inside_ those images, so an image on a different major than the pin reproduces the mismatch above in production rather than on a laptop — and the laptop at least gets a stack trace. Eleven Dockerfiles name a node image (runtime, dev, and every E2E mock), which is exactly the count that makes hand-checking them unreliable.

Four rules keep the pin honest:

- **`.nvmrc` holds a version, never an alias.** `lts/*` resolves to a different major as the calendar moves and per machine — that is the drift, not a way to express a pin. A patch wildcard (`22.x`) is fine: the major is fixed, and a moving minor never moves the ABI.
- **`engines.node` is bounded above.** A bare `>=22` admits Node 25, which is the version that caused the incident above. The guard requires the exact `>=<major> <<major+1>` shape and prints the line to paste.
- **A workflow may name the version or read the file.** `node-version-file: .nvmrc` is the better spelling — it cannot drift, because it _is_ the pin — and the guard accepts it. Pointing it at any _other_ file creates a second pin and is rejected.
- **Bumping Node means bumping all four in one change.** That is the whole point; a bump in some of them is what the guard exists to catch.

The guard reads `FROM` lines only, never prose. These Dockerfiles explain their base image in a comment right above it (`# Pull node:22-slim via …`), so a text search for `node:` would read a stale comment as drift and a sentence as a pin.

`engine-strict` is deliberately **not** set: a mismatch is a pnpm warning, not a refused install. The goal is to make drift visible at install time, not to lock a contributor out of the repo over a minor.

## A Documented Fallback That Cannot Run Is Not A Fallback

`better-sqlite3`'s install script is one line — `prebuild-install || node-gyp rebuild --release`. The left half downloads a prebuilt binary; the right half compiles one when that download is unusable. On 2026-08-05 the left half timed out in CI and the whole dev-stack build died on `gyp ERR! find Python - "" could not be run` (CI run 30994369292 on PR #1110): `Dockerfile.pinchy.dev` installed `libreoffice-writer libreoffice-impress fonts-liberation catdoc` and nothing else, so the right half could not run **at all**.

Read the shape rather than the timeout. This was not a flaky network — it was a transient network failure meeting a fallback that structurally did not exist, and a rerun heals it only for as long as the next download happens to succeed. `Dockerfile.pinchy` (prod) had the same gap, in both its install stages. `Dockerfile.openclaw` has carried `python3 build-essential` since its builder/runtime split and documents this exact module as the reason — one of three files got it right, which is the count at which hand-checking stops working.

Both pinchy images now install the pair, and the placement is the whole trick: prod puts it in `base`, which feeds only `prod-deps` and `build`, so the 306 MB toolchain never reaches the runtime stage (a separate `FROM node:22-slim` that copies the finished `node_modules`). The single-stage dev image genuinely pays those 306 MB, next to LibreOffice's 423 MB, and that is the right place to pay for the fallback existing.

`scripts/lib/native-build-toolchain.mjs` (+ its test, `pnpm test:scripts`) is the tripwire: every Dockerfile stage that installs a manifest containing a compile-at-install dependency must have python3, a C++ compiler **and** make, in that stage or one it descends from. Four details worth knowing before editing it:

- **Ancestry is load-bearing.** A check that read only the installing stage would call the correct `Dockerfile.pinchy` broken, and the obvious way to silence it — duplicating the apt line into `runtime` — ships 306 MB nothing needs. The test asserts both halves: the install stages have the toolchain, `runtime` does not.
- **All three, never any of them.** python3 alone gets node-gyp past `find Python` and into `make: c++: No such file or directory`. Debian's `gcc` is not a C++ compiler and `g++` without `make` cannot run node-gyp either — each is the same dead end, reached one message further along. `build-essential` is the one package that supplies the set.
- **Comments are stripped before anything is matched, including inside a `\` continuation.** These Dockerfiles explain their apt lines in prose directly above them, so a text search would read the explanation of a _deleted_ install as the install — the same "reports on the presence of a string" failure the skip and format gates were each bitten by. And Docker drops a comment line _inside_ a continuation, so a parser that appends an empty string there ends the statement early and loses every package after the comment: the toolchain apt line then reads as a bare `apt-get update`.
- **The manifest decides, not the package manager.** The first draft matched `pnpm install` only, on the theory that the `npm install` lines belong to mock images with tiny pure-JS manifests. That is true of `config/*-mock` and false of the very file this guard holds up as having got it right: `Dockerfile.openclaw` installs `packages/plugins/pinchy-files/package.json` — which depends on better-sqlite3 — with `npm install`, in a stage the guard then never looked at. So a site is classified by resolving the manifest it installs (through the `COPY` that put it there, following `WORKDIR` and any `cd` in the same `RUN`) and asking whether it declares anything in `onlyBuiltDependencies`. The mocks stay exempt because their manifests say express/imapflow/nodemailer/tsx — a fact the guard reads, not a claim someone wrote down. An install whose manifest cannot be resolved (`npm install -g …`) counts as compilable, which is the safe direction. It reads _declared_ dependencies only: a pure-JS package pulling a native one transitively is invisible, and resolving that needs a lockfile the mocks do not have.

Both corpus checks matter and they fail for different reasons: zero install sites means the parser stopped reading Dockerfiles, and zero _compilable_ sites means the classifier stopped recognising the workspace install better-sqlite3 rides in on — the quieter of the two, because every remaining site is then waved through as pure JS. The guard also checks its own premise: an empty `pnpm.onlyBuiltDependencies` means nothing in the workspace compiles at install time, and it says so instead of demanding apt packages nobody can justify.

**Verify a change to any of this by reproduction, not by reading.** Set `npm_config_build_from_source=true` in front of the install — that is exactly what a dead download looks like to the install script — and build. Measured on 2026-08-05: `Dockerfile.pinchy.dev` and `Dockerfile.pinchy --target prod-deps` both failed on `find Python` before the change and both compiled `better-sqlite3` (`gyp info ok`) after it.

## An Outside Reporter Never Waits Silently

A stranger's bug report is the one input with no owner, no retry and no second chance. #849 proved it: someone reported that saving an OpenAI key fails, the report landed through the in-app deeplink **with no labels**, appeared in no triage filter, and sat unanswered for a week. Nothing was broken, no check went red, and that is exactly the failure — the same shape as a gate that reports on what it looks at rather than what it should.

Two mechanisms, because good will is not one:

- **Labelled at the source.** `buildGitHubIssueUrl()` in `packages/web/src/lib/github-issue.ts` passes `labels: "bug,triage"`. It bypasses `.github/ISSUE_TEMPLATE/bug_report.yml`, which is where those labels normally come from, so without them a report born from a real in-app failure is invisible to triage. `.github/workflows/issue-triage.yml` labels every other path into the tracker (`external` + `triage`) on `issues: opened`.
- **Red until answered.** The same workflow sweeps on weekday mornings and **fails** while an external report has gone past the grace period (48 h) with no comment from anyone holding write access. The failed run _is_ the notification — GitHub emails the repo owner, and the run stays red until somebody replies. No new service, no secret, no dashboard nobody opens.

The rule is deliberately blunt: **only a maintainer comment clears the alarm.** No "acknowledged" label, no assignee carve-out, no snooze. If we don't want to answer, the honest move is to close the issue with a reason — not to teach the sweep a way to look away.

Pure logic lives in `scripts/lib/issue-triage.mjs`, covered by `scripts/lib/issue-triage.test.mjs`; the API client has its own `scripts/lib/github-api.test.mjs` (both `pnpm test:scripts`). Four things they exist to stop, each of which would leave the check **green**:

- **Reading part of the tracker.** The sweep paginates and asserts `pageInfo` is present. The repo had 151 open issues against a 100-item page when this landed — the first draft asked for the newest 100 and would have cut off exactly the 51 oldest, i.e. the ones waiting longest. `parsePageInfo` throws rather than assuming one page.
- **Decoding nothing.** `parseIssuesResponse` / `parseIssueEvent` throw on an unrecognised payload instead of returning `[]`. An auth failure or a renamed field must fail loudly; `[]` reads as "nothing is waiting". Note the two payloads disagree on spelling — the webhook says `author_association` / `user` / `html_url`, GraphQL says `authorAssociation` / `author` / `url` — and reading the wrong one yields `undefined`, which classifies as external and would label every issue we open ourselves.
- **Comparing against NaN.** Every arithmetic input is validated before use, because NaN is this sweep's quietest green: `waited > NaN` is false for _every_ issue. `TRIAGE_GRACE_HOURS: "48h"` in the workflow would otherwise report "nothing is waiting" and pass — one character, whole check disabled, no trace. Same for a `createdAt` that stops parsing: the shape check passes and the reporter silently drops out of the result. Both throw, and the error quotes the offending value **as written** (a message built from the converted number says `got null`, which hides the typo it is reporting).
- **Rescuing the failure.** The wiring guard rejects `continue-on-error`, `|| true` and `exit 0` anywhere in the workflow. A green run restores the original bug in one line.

One GitHub-Actions detail worth knowing before editing the workflow: **a `permissions:` block sets every scope it does not list to _no_ access.** Both jobs check the repo out, so both spell out `contents: read`, and only the labelling job gets `issues: write`. Measured rather than assumed — a canary run with `issues: write` alone reported `Issues: write / Metadata: read` and checkout still succeeded, because cloning a _public_ repo needs no authorization. So the omission was not a live break; it was an unstated dependency on this repo staying public, which is worth one line to remove.

`CONTRIBUTOR` counts as **external** (it only means someone had a PR merged once); bot authors do not (automation files issues under an identity with no team association, and counting those would leave the sweep permanently red over reports no human is waiting on). Grace is measured in plain hours rather than business days — the weekday-only cron is what pays for that simplification, and the guard pins it, so a Friday-evening report is surfaced Monday morning instead of waking anyone on Sunday.

## One Full Suite At A Time, And `test:related` For The Rest

Several agent sessions share this machine, and the full vitest suite assumes it owns it: vitest sizes its worker pool from `availableParallelism()` regardless of how many other sessions are doing exactly the same thing. Measured here on 14 cores:

|                      | processes | peak RSS | wall clock             |
| -------------------- | --------- | -------- | ---------------------- |
| one full `pnpm test` | 14–16     | ~4 GB    | 55s                    |
| two at the same time | 54        | ~10 GB   | unfinished after 10min |

That is not a factor of two. Two runs oversubscribe the cores threefold while each holds its own heaps, and the box thrashes. **Serialized, those same two runs cost about 110s.**

Turning vitest's own knobs down was measured and does **not** help — do not reach for them again without new numbers:

- `--maxWorkers=4` made both numbers **worse** (4982 MB, 204s). A vitest worker is reused across files and its heap grows monotonically (122 MB → 504 MB over one run), so fewer workers means more files per worker.
- `pool: "threads"` turns jsdom tests red (`audit-log-table`).
- Capping the per-fork heap (`--max-old-space-size=384`) buys ~15% for ~11% more wall clock.

There is no meaningful saving _inside_ a run. The saving is in not overlapping runs, and in not doing a full run at all when you don't need one:

- **`pnpm test` takes a machine-wide lock** (`scripts/with-test-lock.mjs`, decision logic and measurements in `scripts/lib/test-lock.mjs`). A second run queues instead of piling on. The lock **fails open, and never spins**: an unreadable lock, a lock nobody owns, a holder whose process died, a clock that jumped, or a wait beyond 20 minutes all end with the suite running. It also bypasses itself under `CI` (one job per runner) and under `PINCHY_TEST_LOCK_HELD` (so a suite that shells out to another test command cannot deadlock against its own parent). The worst thing it may do is make a run slow; it must never make one impossible.
- **`pnpm test:related` needs no arguments.** It takes your change set from git — this branch's commits as well as the working tree — translates it for the vitest root, and runs only the tests that import it: 127 files in 19s where the full suite is 717 in 55s. This is the inner loop. It takes no lock. Naming files explicitly still works — `pnpm test:related packages/web/src/lib/audit.ts` or the web-relative `src/lib/audit.ts`, both accepted, because the translation to the vitest root is the script's job rather than yours. A path you name that matches nothing exits **non-zero**: it means the path was wrong, not that a test failed. (With no arguments, a change set this runner does not cover is a pass — nothing ran and nothing should have.)

`test:related` is **not** a verification gate. It cannot see a test that reaches your change through a mock, a string-keyed lookup, or a drift guard that reads the file from disk. Run the full suite before you push.

How much it saves depends entirely on how widely the file is imported, so read the file count it prints rather than assuming. A leaf module pulls in a handful; `src/lib/openclaw-secrets.ts` pulls in 60 of 716 and still costs about a third of a full run, because vitest crawls and transforms the graph either way.

Two properties are load-bearing enough to have cost a rewrite each, and both are guarded by execution probes in `scripts/lib/test-lock.test.mjs` and `test-related.test.mjs` rather than by wiring assertions:

- **The lock is one exclusively-created file, not a directory.** Directory-as-mutex needs `mkdir` and then a second write for the owner, and a waiter landing between the two sees a lock that names nobody — indistinguishable from the genuinely broken lock a killed session leaves, so it clears a live one and both suites run (measured: 3 of 8 concurrent pairs). And "names nobody" must be **cleared**, never reported free: the waiter only looks after its own create already lost, so calling it free sends it back into a create that loses again — a spin at 100% CPU that never runs and never times out.
- **The change set includes commits.** `git diff HEAD` empties the moment you commit, so a working-tree-only reading answers "nothing changed" on a branch full of work — a zero-test run, exit 0, arriving exactly when you are checking a commit before pushing.

## Commands

Development should use Docker Compose because the app depends on PostgreSQL, OpenClaw, and migrations:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

With a development enterprise key:

```bash
PINCHY_ENTERPRISE_KEY=dev-enterprise docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Production-style run:

```bash
docker compose pull && docker compose up -d
```

### Running a dev stack per worktree

Two worktrees cannot both run the dev stack on the default ports. Allocate a free block for the current worktree once, then use the ordinary command:

```bash
pnpm worktree:env
```

It writes `COMPOSE_PROJECT_NAME`, `DEV_PINCHY_PORT`, `DEV_DB_PORT` and `DEV_CADDY_PORT` into a gitignored `.env`, which Compose reads automatically. Allocation happens **once** and is not re-derived on later runs — a worktree's address should stay bookmarkable — so pass `--force` if you need a new block. `pnpm -C packages/web test:db` follows the allocation on its own.

Do not hand-write a `docker-compose.local.yml` with `ports: !override` for this any more. That was the old workaround and it is easy to get wrong: a bare `ports:` **appends** instead of replacing, so the conflict survives the override that was meant to fix it.

The compose defaults are unchanged (`7777`/`5434`/`8443`), so a checkout without `.env` behaves exactly as the docs describe.

**The `DEV_` prefix is load-bearing.** Compose reads `.env` for _every_ stack started from the repo root, and `docker-compose.yml` — the base file every E2E overlay layers on — reads `PINCHY_PORT`. Writing that key per worktree therefore moved six E2E suites off the `:7777` their Playwright configs expect (`telegram` hard-codes the URL and has no override at all), and the failure surfaces as a connection timeout with nothing pointing back at the allocation. Only `docker-compose.dev.yml` reads the `DEV_*` keys, so only stacks that include it move. A stack that _does_ layer the dev overlay (`odoo`, `eval`) must pin its ports back with `ports: !override`.

Two guards in `scripts/lib/dev-stack-port-isolation.test.mjs` hold that line: one fails if a generated key is read outside the dev overlay or a dev-layered stack stops pinning, the other fails if a hard-coded host port anywhere in the repo lands inside an allocation band without being listed in `RESERVED_PORTS`. The reserved list matters because a probe only sees what is bound _right now_ while allocation is sticky: a worktree allocated while the integration stack was down would take `7779` and keep it.

### Every published port binds loopback

A `ports:` entry with no host IP — `"5434:5432"` — publishes on `0.0.0.0`. Every test overlay was written that way, so on a shared dev box or a CI runner with a routable address the test Postgres instances, each suite's Pinchy override and all eight mock servers answered the whole network: the odoo mock accepts writes, greenmail hands out mail, and the databases hold seeded credentials. Nothing was red, because reaching them over loopback works identically either way.

The prefix (`"127.0.0.1:5434:5432"`) is one token per line across nine files with no locally visible failure mode — the shape of every drift this repo has already paid for. `scripts/lib/compose-port-bindings.test.mjs` (pure logic in `compose-port-bindings.mjs`, run by `pnpm test:scripts`) is the tripwire. Three things worth knowing before editing it:

- **There is no list of accepted exceptions, deliberately.** A stack that genuinely needs a routable bind writes it the way `docker-compose.yml` does — `"${PINCHY_PORT:-127.0.0.1:7777}:7777"` — so the _default_ is loopback and an operator who wants more says so in their own environment. A checkout binds what its files say; nobody is exposed by omission.
- **The parser throws on input it cannot read** rather than skipping the line. The long syntax (`- target: 9001` / `published:`) also binds every interface when `host_ip` is omitted, and a guard that silently ignores it reports on the lines it happens to understand instead of on what the stack binds.
- **`docker-compose.dev.yml` spells the prefix two different ways, three lines apart.** `DEV_PINCHY_PORT` carries `127.0.0.1:` _inside_ the value (`managedValues` in `scripts/lib/env-file.mjs` writes it); `DEV_DB_PORT` and `DEV_CADDY_PORT` are bare numbers whose prefix the compose file supplies. Both halves are needed and neither can be "harmonised": adding the prefix to `DEV_DB_PORT` resolves to `127.0.0.1:127.0.0.1:5444:5432`, and removing it from `DEV_PINCHY_PORT` puts every already-allocated worktree back on `0.0.0.0` — a break that appears only in a worktree that has run `pnpm worktree:env`, never in CI and never in a fresh clone. The guard resolves the dev overlay against the values `managedValues` really writes, so it fails in both directions.

Verify a change to it by reproduction, not by reading: drop a `127.0.0.1:` from any overlay and watch that exact line come back in the failure.

Common host commands from the repository root:

```bash
pnpm test
pnpm test:related
pnpm build
pnpm test:scripts
pnpm typecheck:plugins
pnpm test:plugins
pnpm format
pnpm format:check
```

Useful web package commands:

```bash
pnpm -C packages/web lint
pnpm -C packages/web db:generate
pnpm -C packages/web test
pnpm -C packages/web test:db
pnpm -C packages/web test:e2e
pnpm -C packages/web test:e2e:telegram
pnpm -C packages/web test:e2e:odoo
pnpm -C packages/web test:e2e:web
pnpm -C packages/web test:e2e:email
pnpm -C packages/web test:integration
```

Docs commands:

```bash
cd docs && pnpm install && pnpm dev
cd docs && pnpm build
```

`scripts/lib/agents-md-commands.test.mjs` (run by `pnpm test:scripts`) keeps these blocks honest: it walks every `pnpm` command in this file, resolves each to the package it runs in — handling `-C`/`--dir`/`--filter`, `cd x && pnpm y` chains, `pnpm run <script>`, and pnpm builtins like `install` — and fails if the script isn't declared there. That drift is how `pnpm lint`, `pnpm format` and `pnpm db:generate` sat here for months as root commands that never existed. Nothing else in CI reads this file.

The same guard reads CONTRIBUTING.md, which drifted the same way (`pnpm db:migrate` and `pnpm test:db` documented as root scripts). It reads fenced `bash` blocks **only**, in both files: a command written inline in prose is not checked, because both files also quote commands historically (`pnpm --filter @pinchy/web format:check`, the gate as it was until 2026-07) and with placeholders (`pnpm test:e2e:<suffix>`), and a guard that flagged those would be switched off within a week. So an inline `pnpm …` is review's job — a fenced one is the guard's.

Important: do not run the app with plain `pnpm dev` as the primary development path unless a task explicitly requires it. Direct local app startup can miss Docker-managed infrastructure and migrations.

## API Routes And Audit Trail

Every state-changing `POST`, `PUT`, `PATCH`, or `DELETE` API route must write an audit entry unless it has an explicit `// audit-exempt: <reason>` comment.

For request bodies, use `parseRequestBody(schema, request)` from `@/lib/api-validation`. Do not call `await request.json()` directly in routes that parse client input. Validation failures should return structured 400 responses that clients can render inline.

Audit logging rules:

- Every `appendAuditLog` call must include `outcome: "success" | "failure"`.
- Prefer `await appendAuditLog(...)` for idempotent state changes.
- Use `deferAuditLog(...)` from `@/lib/audit-deferred` for non-rollbackable side effects that already happened in a request context.
- Use `try { await appendAuditLog(...) } catch (err) { recordAuditFailure(err, entry) }` in WebSocket, cron, or non-request contexts.
- Never fire-and-forget audit writes with `.catch(console.error)`.
- Snapshot human-readable names beside IDs with `{ id, name }` pairs.
- Log what changed, not only that something changed.
- For membership changes, log added/removed diffs rather than final counts alone.
- Include resource names in delete-event details because deleted rows may no longer be queryable.
- Keep audit `detail` under 2048 bytes. Summarize bulk operations.
- Never write plaintext email addresses or other PII into audit `detail`. Use `redactEmail()` from `@/lib/audit` when email identity is required.
- Never mirror the **acting** user's raw `users.id` into `detail`. `appendAuditLog` pseudonymizes the `actorId` **column** (`resolveActorId`) so GDPR crypto-erasure can reach it, while `detail` is stored verbatim in an immutable, HMAC-chained row that cannot be rewritten. The actor is already on the row; to filter audit rows by a known user, resolve `actorId` through `resolveActorIdMatchSet` on the read side (#824).
- For batched maintenance operations (e.g. GC sweeps), include a `sweepId` UUID in every emitted audit row so analysts can correlate the full sweep from one drill-down query.

Checklist for state-changing routes:

1. Body validation uses `parseRequestBody`.
2. Audit call or `audit-exempt` comment is present.
3. Audit write pattern matches the action shape.
4. Event type uses a valid `AuditResource` prefix or approved non-resource family.
5. Detail payload matches the event type.
6. Referenced entities are snapshotted as `{ id, name }`.
7. A test verifies the audit call and payload.
8. `outcome` is set correctly.
9. No plaintext PII appears in audit `detail`, and the acting user's raw id is carried by `actorId` alone.

## Shared Schemas And Typed Client

For state-changing API routes, define request schemas in `packages/web/src/lib/schemas/<feature>.ts` and import them from BOTH the route handler (for `parseRequestBody`) and the client component (for typed request bodies via `z.infer`).

Use the typed helpers in `packages/web/src/lib/api-client.ts` (`apiPost`, `apiPatch`, `apiPut`, `apiDelete`, `apiGet`) instead of raw `fetch` in client components. They throw `ApiError` on non-2xx responses, which components catch and surface via `toast.error(e.message)`.

This makes contract drift between client payload and server schema a compile-time error rather than a runtime 400.

## Error And Notification UI

Use inline form errors when the error is tied to a field, the user can correct the input, and the form/dialog stays open.

Use toast notifications for completed actions, background/system errors, and transient errors the user can simply retry.

Use a persistent, dismissible inline banner (not an auto-expiring toast) for a permanent, actionable error that lands after a full-page redirect — e.g. an OAuth connect failure surfaced via a `?error=` query param. "The action navigated away" does NOT by itself justify a toast: after a redirect the user's attention is on the provider, so a few-second toast is gone before they read it, and the error needs a configuration fix that outlives a toast. Classify by whether the error is transient-and-retryable (toast) or permanent-and-actionable (persistent inline banner), not by whether the flow navigated.

Do not mix inline errors and toast errors for the same action. Success confirmations should be toasts unless a multi-step flow intentionally shows a success screen.

## Secret Handling

Pick the secret-handling pattern based on who consumes the secret at runtime.

### Pattern A: OpenClaw built-in resolves SecretRef

Use `secretRef(pointer)` from `packages/web/src/lib/openclaw-secrets.ts` for paths OpenClaw itself walks at runtime:

- `models.providers.<name>.apiKey`
- `env.<VAR>` templates resolved against process env

Add the value to the `SecretsBundle`, write the reference into `openclaw.json`, and test both halves.

### Pattern B: Pinchy plugins fetch credentials through the API

Preferred for credentials consumed by `packages/plugins/pinchy-*` plugins.

Do not put third-party credentials, or even a SecretRef pointer, into arbitrary plugin config blocks in `openclaw.json`. OpenClaw 2026.4.x does not resolve SecretRefs in arbitrary plugin config trees, so plugins can receive unresolved objects.

Instead:

- `regenerateOpenClawConfig()` writes only `apiBaseUrl`, `gatewayToken`, and an opaque `connectionId` into plugin config.
- The plugin lazily fetches credentials from `GET /api/internal/integrations/:connectionId/credentials?agentId=<id>` using the gateway token as Bearer auth. **The `agentId` is required**: the gateway token is one shared secret inlined into every plugin's config, so it proves the caller is inside the OpenClaw container and nothing about which connections it may read. Pinchy checks the named agent's grant (`agent_connection_permissions`, or the tool grant for the instance-wide web-search connection) before decrypting, and a refusal writes an `integration.credentials_denied` audit row (#987). A new plugin that fetches credentials must pass its `ctx.agentId` through — omitting it is a `400`, deliberately, because a lenient fallback would be a one-parameter route back to token-only authorization.
- Cache credentials in the plugin, usually with a 5-minute TTL, and invalidate on 401 for rotation.
- Validate credential shapes at the plugin edge with clear type errors.
- Test web config emission, plugin cache/refetch behavior, plugin integration against mocks, and manual staging behavior when relevant.

Every Pinchy plugin manifest must declare every config field emitted by `regenerateOpenClawConfig()` and use `additionalProperties: false`. Keep these in sync when adding or changing a plugin:

- `KNOWN_PINCHY_PLUGINS` in `packages/web/src/lib/openclaw-config/plugin-manifest-loader.ts`
- The plugin's `openclaw.plugin.json#configSchema`
- The plugin's `config-schema.test.ts`

### Pattern C: Bootstrap credentials

`gateway.auth.token` and `plugins.entries.pinchy-*.config.gatewayToken` are plaintext bootstrap credentials in `openclaw.json`. They are the trust root for the OpenClaw container and cannot be fetched through Pinchy's API. Rotate by regenerating config and restarting OpenClaw.

Defense in depth:

- `packages/web/src/lib/openclaw-plaintext-scanner.ts` checks generated `openclaw.json` for known provider key prefixes. Add patterns when onboarding providers with recognizable secret prefixes.
- `packages/web/src/lib/openclaw-config/validate-built-config.ts` validates emitted plugin entries against manifests before writing config.

### Three Digits Are Not A Status

Every Pattern-B plugin needs the same four things: fetch the credentials, cache them, decide whether an error means "these are stale", and retry once. `pinchy-odoo`, `pinchy-email` and `pinchy-web` each grew their own, and by 2026-08 all three had drifted (#1077) — three cache-key conventions, three auth matchers, and in every one of them a test for the bare substring `401`:

```
odoo   'access denied' | 'invalid api key' | '401' | 'authenticat'
email  '401' | 'invalid credentials' | 'invalid_grant' | 'token has been expired' | 'unauthorized'
web    '401' | 'unauthor' | 'invalid api'
```

Odoo's `MissingError` names the record (`Records: sale.order(401,)`). An unbalanced-entry error names the amount. Graph echoes the recipient, and a mail about a 401(k) plan carries those digits into the error body — as does the GUID request-id Microsoft stamps on every error, in roughly one failure in seventy. The cost is not a wasted retry: the second failure POSTs `report-auth-failure`, which flips the connection to `auth_failed`, shows admins a "reconnect" banner in Settings → Integrations, and writes an `integration.auth_failed` audit row for an auth failure that never happened.

So: **a number classifies only as a structured status; prose classifies only on words.** `isAuthError` in `credential-client.ts` reads `status`/`statusCode`/`response.status`/numeric `code` first and falls back to word patterns — never to digits. That narrowing has a price, and paying it is part of the change: `BraveSearchError` and `GraphRequestError` now carry `status`, because Brave's real 401 body (`{"code":"SUBSCRIPTION_TOKEN_INVALID"}`) contains no auth word at all and would otherwise stop triggering a refresh. A new provider client that throws on a non-ok response must carry its status the same way.

Three more rules fall out of the same incident:

- **The module is duplicated, byte-for-byte, and that is forced rather than sloppy.** Each plugin directory is mounted into the OpenClaw container standalone (`./packages/plugins/<name>:/root/.openclaw/extensions/<name>`), so an import escaping the plugin directory resolves to a path that is not there at runtime — the same bundle-isolation shape as `normalizeTableHtml`, with the same answer. `plugin-credential-client-drift.test.ts` compares the copies byte-for-byte and also fails on a plugin that grows a _second_ classifier in its own `index.ts`, which the byte comparison cannot see. Edit the `pinchy-odoo` copy, then copy it over the other two. The module's unit tests live once (`pinchy-odoo/__tests__/credential-client.test.ts`) and count for all three copies only for as long as that guard passes.
- **A cache key names every input the cached value was built from.** `credentialCacheKey(agentId, connectionId)` — odoo keyed on the agent alone, so a client built from one connection's credentials could outlive a connection swap by a full TTL. Reachability today depends on OpenClaw re-running `register()` on a config change (which rebuilds the cache anyway); the key is still wrong, and "the other input happens to be constant right now" is a property of today's config, not of the cache.
- **The retry may repeat the closure only while nothing has been written.** `trackMutations` wraps the client and marks a mutation when a mutating method **resolves** — not when it is called. That distinction is the whole point: a rejected write changed nothing (an Odoo RPC is transactional, a rejected send did not send), so re-running it under a fresh token is exactly what the retry exists for; marking on entry would disable the transparent refresh for every write tool. No closure in the tree performs a step after its mutating call today, so this is a **tripwire**, not a live fix — it fires the moment someone adds one, instead of that edit silently duplicating a record or an email. Wrapping centrally rather than annotating ~30 call sites is what makes it unforgettable. That same fact is why the gate cannot be proved by running it, and deleting `if (mutated) throw err` from `pinchy-odoo/index.ts` leaves all 493 of that plugin's tests green — so the drift guard checks textually instead: a plugin that wraps a client in `trackMutations` must also read the flag. Derived from the source rather than from a list, so a write tool landing in `pinchy-web` is covered the day it arrives.

## Plugin Integration Contract

Every plugin in `KNOWN_PINCHY_PLUGINS` must be classified as external or internal and have matching test/plumbing coverage.

External-integration plugins, such as web search, email, Odoo, and future third-party services, must have:

- Entry in `EXTERNAL_INTEGRATION_PLUGINS`.
- Mock server in `config/<suffix>-mock/` with third-party API surface and `/control/{health,reset,seed,...}` endpoints.
- `docker-compose.<suffix>-test.yml` overlay.
- Playwright config at `packages/web/playwright.<suffix>.config.ts`.
- E2E spec at `packages/web/e2e/<suffix>/<suffix>.spec.ts` covering plugin load, at least one tool round trip, audit log entries, and permission/filter behavior where relevant.
- `pnpm test:e2e:<suffix>` script in `packages/web/package.json`.
- `<suffix>-e2e` job in `.github/workflows/ci.yml` using the production `Dockerfile.pinchy` image.

Internal plugins, such as files, context, docs, and audit, must be listed in `INTERNAL_PLUGINS` and exercised by `packages/web/e2e/integration/agent-chat.spec.ts` or another E2E spec with a clear assertion comment mentioning the plugin id.

### Typecheck gate

Plugins run via `tsx` at runtime with no ahead-of-time type checking elsewhere in CI (root `pnpm build` is `next build`, which only typechecks `packages/web`; `Dockerfile.openclaw` only installs plugin deps). `pnpm typecheck:plugins` (`scripts/typecheck-plugins.mjs`, wired into the `quality` job) runs `tsc --noEmit` against every `packages/plugins/pinchy-*` plugin's own tsconfig.

Each plugin's `tsconfig.json` must be uniform so the gate is meaningful:

- `"include": ["**/*.ts"]` with **no** `exclude` — typechecks production **and** `__tests__/*.test.ts`, so vitest `expectTypeOf` contract tests are real compile-time checks instead of runtime no-ops (the earlier root-only `include: ["*.ts"]` / `exclude: ["*.test.ts"]` silently skipped every test file).
- `"compilerOptions"`: `skipLibCheck: true` (third-party `.d.ts` files otherwise break the gate) and `types: ["node", "vitest"]`, backed by an `@types/node` devDependency (`types: ["node"]` throws TS2688 without it).

The drift guard `scripts/lib/plugin-typecheck.test.mjs` (pure logic in `scripts/lib/plugin-typecheck.mjs`, run by `pnpm test:scripts`) fails fast if any plugin isn't wired this way, so a new plugin can't silently escape the gate — the read-side sibling of the no-untracked-skips / no-test-deletion guards.

### Unit test gate

Every plugin package must ship vitest unit tests and declare `"test": "vitest run"` in its package.json. The test files run twice in the CI quality job, deliberately: once inside `pnpm test` via the `../plugins/pinchy-*` include in `packages/web/vitest.config.ts` (web config), and once per package via `pnpm test:plugins` (each plugin's own config and dependencies, as run locally). Two drift guards in `packages/web/src/__tests__/lib/plugin-test-coverage.test.ts` enforce this: every plugin test file must match the include globs, and every plugin package must declare a `test` script (pnpm recursive runs silently skip packages without one).

### Every plugin `fetch()` passes a signal

An unbounded `fetch` has no failure mode that looks like a bug — the call simply never returns. A Pinchy container mid-deploy, or a blackhole that swallows packets without an RST, leaves the plugin waiting forever, and in `pinchy-audit`'s `before_tool_call` hook that stalls every tool call of every agent with nothing in any log naming the cause.

`packages/web/src/__tests__/lib/plugin-fetch-timeout-coverage.test.ts` requires a `signal` on every `fetch()` in plugin production code. It exists because the change that added the 15 original timeouts also wrote, in a comment, that the mailbox providers "bound themselves separately (see graph-adapter.ts, gmail-adapter.ts, imap-adapter.ts)" — and `gmail-adapter.ts` did not: it reaches Gmail through googleapis, whose transport documents `timeout` as "No timeout by default". Prose asserted coverage the code lacked, and nothing could contradict it. Same argument as § "A Hand-Maintained List That Mirrors Code Will Be Wrong".

Three things to know before editing it:

- **Pick the bound from the call's legitimate worst case, not from a latency budget.** Too long merely delays an error; too short turns working calls into failures that read as product bugs. That asymmetry is why the vision API sits at 120s hosted / **300s for Ollama** — the offline path pays a model load before decoding starts, and a shared 30s bound would break exactly the self-hosted deployments Pinchy promises to support. Pinchy-internal, same-Docker-network calls use 10s; external APIs 30s; anything that streams a file body gets its own larger bound (`ATTACHMENT_TIMEOUT_MS`), because an AbortSignal covers the body read, not just the response headers.
- **Never write `init.signal ?? AbortSignal.timeout(...)`.** It reads as a harmless escape hatch and is a trap: the first caller to pass a cancellation signal silently loses the timeout, and no test can see it. Both wrappers here (`GraphAdapter.req`, `fetchWithRetry`) type `signal` out of their options and take a `timeoutMs` instead. Create the signal **inside** a retry loop, too, so each attempt gets a fresh bound rather than all attempts sharing one deadline the first one spent.
- **It sees `fetch` and nothing else.** A plugin reaching the network through another transport is invisible to it — today `gmail-adapter.ts` (googleapis/gaxios, bounded by its `timeout` option) and `imap-adapter.ts` (imapflow, `connectionTimeout`/`socketTimeout`). It also checks only that a signal is passed, never that the value is sane. Both limits are covered by per-call unit tests instead. Verify a change to the guard with a canary — delete a `signal:` from a plugin, watch it name that exact file and line, put it back.

### A Failing Tool Result Needs `details.error`, Not Just `isError`

OpenClaw strips the MCP `isError` flag before forwarding a tool result to `/api/internal/audit/tool-use` (#404), so the audit route's only remaining failure signal is `result.details.error` — see the three-source precedence comment in that route. A tool that fails while setting only `isError: true` is written to the audit trail as **`outcome: success`**. The failure is not merely unlogged; it is logged as its opposite, which is worse than silence for anyone reading the trail afterwards. pinchy-odoo and pinchy-email carried a `toolError()` helper for this; five other plugins did not.

Every plugin now routes error results through its own `toolError(text)` helper, and `packages/web/src/__tests__/lib/plugin-tool-error-details-drift.test.ts` (scan in `plugin-error-details-extraction.ts`) enforces it by AST-walking each `packages/plugins/pinchy-*/index.ts`.

Three details are load-bearing, each because the first draft got it wrong and a canary caught it:

- **The scan unwraps `as const` and parentheses.** An `expr.kind === TrueKeyword` test skips `isError: true as const` entirely — and pinchy-email's session-less tool stub is written exactly that way, so the strict check silently exempted one of the very results it was written to cover.
- **A computed `isError` is flagged, not waved through.** `isError: result.isError` is how `pinchy_web_fetch` shipped without `details.error` in the first place. A scan that judges only the literal `true` cannot see that shape come back, so it is reported as `dynamic-is-error`: branch on the flag and return `toolError(...)` on the error side.
- **An unreadable `index.ts` throws.** Every assertion here is an _absence_, so a failed read and a clean file are the same empty list — returning `[]` would turn the guard green for a plugin it never opened. This is the one place it must diverge from `deriveToolsFromSource`, where an empty list turns the manifest comparison red instead. A corpus floor (`checked >= 10`, against 14 present when this landed) covers the same failure one level up.

Verify a change to the scan by reproduction, not by reading it: break one plugin result, watch the guard name that plugin, put it back. The `scanErrorResults` fixtures in the guard's second `describe` pin all four shapes above.

Known limitation: the scan reads `index.ts` only, matching `deriveToolsFromSource`. A plugin that builds an MCP result in a sibling module escapes it. Nothing does today — pinchy-web's `web-fetch.ts` returns an internal `{ content: string; isError }` DTO that `index.ts` translates through `toolError()`.

### Tool dispatch coverage

Every plugin tool must be covered at three layers:

1. **`openclaw.plugin.json#contracts.tools`** — list every tool name. OpenClaw 5.3+ silently ignores `registerTool()` calls that are not declared here. The bidirectional drift guard (`manifest-tools-drift.test.ts`) enforces that this list matches the `registerTool()` calls in `index.ts`.

2. **Drift guard** — `packages/web/src/__tests__/lib/manifest-tools-drift.test.ts` checks that `contracts.tools` and `registerTool()` are in sync. Runs in `pnpm test`.

3. **Behavior test** — at least one tool per plugin must have an E2E test that:
   a. Sends a chat message containing a trigger string handled by `fake-ollama-server.ts`.
   b. The fake LLM returns a deterministic `tool_calls` response for that tool.
   c. The test asserts the audit entry appears, either via a literal `/api/audit?eventType=tool.<toolName>&limit=10` query or via the shared `pollAuditForTool({ toolName, agentId })` helper in `packages/web/e2e/shared/dispatch-probe.ts`.

   The coverage guard (`plugin-tool-coverage.test.ts`) scans all `*.spec.ts` files for both `eventType=tool.<toolName>` and `pollAuditForTool(... toolName: "<toolName>" ...)` patterns. If a plugin has tools but no matching E2E assertion, CI fails there.

   **A probe inside a skipped test does not count.** The scan drops matches inside `test.skip` / `test.describe.skip` / `.todo` / `.fixme` / `xit` / `xdescribe` blocks (`extractCoveredTools` in `plugin-tool-extraction.ts`, unit-tested in `plugin-tool-coverage-skips.test.ts`). It used to count them, and two specs kept dead probes in the tree for exactly that reason — the comments said "skipped tests count for static scans" out loud (#834). A guard a never-running test satisfies reports on the presence of a string, not on the existence of a test. `.skipIf(...)` is not a skip: it is a runtime gate, and its body still counts. When a probe is blocked on infrastructure, keep it (tracked, per the skip policy) but do not let it stand in for coverage — write one that runs, or accept that the plugin is covered by a different tool's probe.

**Recipe for adding a new tool to an existing plugin:**

1. Add `registerTool(api, schema, { name: "new_tool" }, handler)` in `index.ts`.
2. Add `"new_tool"` to `contracts.tools` in `openclaw.plugin.json`.
3. Add a `TriggerConfig` entry in `packages/web/e2e/shared/fake-ollama/fake-ollama-server.ts`.
4. Export the trigger constant from `fake-ollama-server.ts`.
5. Add a `test.describe` block (or extend an existing one) in the relevant E2E spec that sends the trigger and calls `pollAuditForTool(page, { toolName: "new_tool", agentId })` (or polls the literal `/api/audit?eventType=tool.new_tool` URL).

**Recipe for adding a brand-new plugin:**

Follow the Plugin Integration Contract above, then apply the tool dispatch coverage recipe for each tool the plugin registers.

#### Ref-based tools (opaque `_pinchy_ref` inputs)

A static `TriggerConfig` cannot cover a tool whose primary argument is an opaque `_pinchy_ref` (pinchy-odoo's `odoo_reconcile`, `odoo_schedule_activity`, `odoo_attach_file`, the record-action tools, …). The ref is minted at runtime (per connection, per record) and is unknowable when the trigger is authored, so a hard-coded ref only ever exercises the plugin's decode-rejection path — not real dispatch.

The fake-LLM instead resolves the ref **dynamically**, exactly like a real model: it first dispatches `odoo_read` (once per ref the tool needs), then reads the real `_pinchy_ref` back out of that tool-result message and reuses it in the ref-based tool. The reusable engine is `buildRefDispatchScript(probe, messages)` + `extractPinchyRefsInOrder` in `fake-ollama-server.ts`, driven by the `REF_DISPATCH_PROBES` registry (one `RefDispatchProbe` per tool: `reads` models → `toolName` with `buildArgs(refs)` → final text). Multi-ref tools work too: `odoo_reconcile` reads `account.move` then `account.payment` and reconciles on both refs positionally. All of it is unit-tested in `fake-ollama-ref-dispatch.test.ts`. Every ref tool has a probe in `odoo-agent-chat.spec.ts` (the "Odoo dispatch probe" block) asserting `outcome=success` via `pollAuditForEvent`, not just that a row exists — a broken ref still dispatches (audited `failure`).

A dedicated guard, `odoo-ref-tool-e2e-coverage.test.ts` (pinchy#791), enforces this per-tool: it auto-detects every ref-based odoo tool from the plugin source and requires each to be either E2E-covered or carry a `PENDING_E2E` exemption citing the tracking issue. `PENDING_E2E` is now **empty** — all ten ref tools are covered. A **new** ref-based odoo tool with neither coverage nor an exemption fails CI. To cover the next one: add a `RefDispatchProbe` entry (its `reads` model must be seeded in the spec's `beforeAll` and the agent granted read on it, plus whatever write/create the tool checks), add the spec probe, and confirm the guard stays green.

`odoo_reconcile` is covered via the **payment-counterpart** path only: the mock's `js_assign_outstanding_line` handler zeroes the bill's `amount_residual`, which is the sole signal the plugin's `didReconcile` trusts, so `outcome=success` proves the real verification path rather than a blind return value. The **bank-statement** counterpart path (x2many write-command expansion + journal suspense/default accounts, which real Odoo 19 makes silent-no-op-prone) is deliberately left on live verification — a naive mock of it would risk a false-green, and the payment path already discharges the tool's coverage obligation.

## Documentation

- Docs live in `docs/`, use Astro Starlight, and follow the Diataxis framework.
- Docs are standalone, not part of the root pnpm workspace.
- Every feature plan should include a documentation update task.
- When behavior changes, update docs in the same PR.
- Read `PERSONALITY.md` before writing user-facing text. Use English, "we" perspective, and the established Pinchy voice.

### In-Page Anchors Are Checked By The Docs Build

A link to a heading that does not exist — `[see the config](/guides/setup/#nope)` — used to be caught by nothing (#769). The `links` job (lychee) passes `--exclude-path docs` **on purpose**: in the source `.mdx`, `/guides/setup/#configure-openclaw` is a route into the _generated_ site, not a file on disk, so checking it there produces noise rather than signal. And the astro build fails on MDX _syntax_ while being perfectly happy with a dead anchor. So the docs — the thing users read, and the thing Smithers reads on demand through `pinchy-docs` — were the one place a broken link shipped silently. Five were live on docs.heypinchy.com when the check landed, two of them because a `<Badge>` inside a heading gives it a trailing hyphen (`#access-tab` is really `#access-tab-`).

The check is `docs/scripts/check-anchors.mjs`, run by `pnpm -C docs check:anchors` **after** `pnpm -C docs build`. It reads `docs/dist/` — every `<a href>` and every `id="…"` in the HTML that actually ships — and resolves the two against each other. Same rule as the X-Frame-Options gate above: assert what a concrete URL resolves to, not what a source file asked for. `scripts/lib/docs-link-gate.test.mjs` (`pnpm test:scripts`) pins the wiring, including the **order**: the checker reads the build's output, so a check that runs first passes against a stale dist.

It lives in `quality` because `quality` already builds the docs and is ungated (see § "CI Path Filtering Is Job-Level, Never Workflow-Level"). A job of its own would have needed a `changes` gate and then skipped on exactly the docs-only PRs it guards — bug #764 from the other direction.

**Do not reach for `starlight-links-validator` instead; it was tried and it does not work here.** The plugin registers its collectors through `markdown.remarkPlugins`/`rehypePlugins`, which Astro 6.4 deprecated and `@astrojs/mdx@5` no longer forwards. Against our 64 `.mdx` pages and one `.md` page it collects nothing from the `.mdx` files, reports one _bogus_ "invalid link" from the `.md` one, and misses a deliberately broken anchor entirely — a gate that fails loudly on the wrong thing while checking nothing. Both `0.24.1` (the Astro 6 line) and `0.25.2` (Astro 7 / Starlight ≥ 0.41) behave that way here. Revisit only after the docs move to Astro 7, and then only with the canary below.

#### A second check reads the built site: does the markdown render?

`check:anchors` asks whether links resolve. It says nothing about whether a page is legible, and v0.9.0 shipped 41 of 69 pages where every table was a paragraph of literal `|` characters. astro@6 deprecated `markdown.gfm` and leaves it `undefined`; `.md` falls back to the default (`true`), but `@astrojs/mdx@5` reads `config.markdown.gfm` and takes `undefined` as off — so every `.mdx` page lost remark-gfm. Nothing was red: the build succeeded, prettier sees a paragraph and formats it as one, and the anchor check only ever looked at links.

`docs/astro.config.mjs` now sets `markdown.gfm: true` explicitly. Astro prints a deprecation warning pointing at `unified({ gfm })` instead — **do not follow it.** MDX reads `config.markdown.gfm`, not the processor's copy, so that move looks like a modernisation and silently restores the bug.

`docs/scripts/check-rendered-tables.mjs` (`pnpm -C docs check:rendered`, in `quality` after the build) is the guard, and it checks the **symptom**, not the config: a built page containing a line that both starts and ends with `|`. The next way to lose gfm will not look like this one, but it will look like this in `dist/`. `scripts/lib/docs-link-gate.mjs` pins both built-site checks — script, checker, and the ordering.

The same guard also pins `pnpm -C docs test`, which runs **before** the build (it reads its own fixtures, not `dist/`). Both checkers are ordinary code, and a checker rewritten to find nothing passes cheerfully against a healthy `dist/` — their unit tests are the only thing that would notice. Until #1007 those tests ran nowhere but on a developer's laptop, which is the same shape as the gate that reports on what it looks at rather than what it should.

The general rule is the one the X-Frame-Options gate follows: assert what a built page contains, not what a source file asked for. Neither check covers `<img src>`, and external links out of `docs/` stay unchecked.

`check:rendered` errs loud rather than silent, deliberately: **inline** code is not stripped, so a page that documents table syntax in an inline `` `| a | b |` `` on a line of its own would be flagged. Nothing in the 69 pages does that today. If one ever needs to, rewrite it as a fenced block — do not teach the checker to skip `<code>`, because a real unrendered row containing inline code (``| `foo` | bar |``) lives in exactly that markup.

#### `llms.txt` Is Generated, Never Committed

`llms.txt` and `llms-full.txt` are what AI crawlers read instead of the site. Both used to be hand-written files under `docs/public/`, and both rotted precisely the way § "A Hand-Maintained List That Mirrors Code Will Be Wrong" predicts. Measured on 2026-08-04 (#1080): the index listed **12 of 66** pages, the full text carried **9**, and what it carried described April-era Pinchy — `Auth.js` for an app that runs Better Auth, dev database port `5433` for a stack that binds `5434`, and not one mention of IMAP or the knowledge base. Live, on docs.heypinchy.com, for months. Nothing was red, because nothing read them.

`docs/scripts/generate-llms-txt.mjs` writes both into `dist/` from `src/content/docs`, so a new page is in both files on the next build. Five details are load-bearing:

- **It runs INSIDE the build** — `astro build && node scripts/generate-llms-txt.mjs`, wrapped by `with-restore.sh`. `dist/` has to exist to write into, and the source tree only carries injected `%%PINCHY_VERSION%%` values until the restore step. Moved after it, the generator publishes the literal placeholder inside install commands, to every crawler. `findLeakedSource` in the checker is the tripwire for exactly that ordering mistake — verified by reproduction (run the generator standalone after a build: 21 problems, all placeholders).
- **Sections come from the directory tree, not a label map.** A map would be the hand-maintained list this replaced, one level up.
- **`check:llms` reads `dist/`, both directions.** Every page the built site serves is in both files, and every entry in them is a page the site serves. A documentation page is defined as one carrying Starlight's `generator` meta — that is what separates the 66 real pages from `public/installing.html` (the 1-click-deploy splash) and astro's redirect stubs, without a list of exceptions.
- **The generator is also the guard for aside types.** Starlight renders `:::note`, `:::tip`, `:::caution`, `:::danger` and nothing else; remark-directive eats anything else and emits a bare `<div>` — no colour, no icon, no label, no error. Two `:::warning` blocks shipped that way. The generator has to read the directive anyway, so it throws and names the file.
- **Inline code is verbatim, exactly like a fenced block.** A prose placeholder is shaped like a component tag, so running the JSX stripper over a code span _deletes documentation_: `` `env.<VAR>` `` became `` `env.` ``, and the API reference published `"at": ""` for a field that carries a timestamp. **`check:llms` structurally cannot see this** — `findLeakedSource` asks what survived, and the failure mode is a deletion. The guard is instead `generate-llms-txt.test.mjs`'s corpus test: every single-line code span in every page must appear in that page's output. It reads the same corpus the build does, so a page added tomorrow is covered the day it lands; spans that _wrap across a source line_ are re-flowed on purpose and are the one thing it cannot speak for. Verify a change to it with a canary — put the strip back, watch it name `secrets.md`, `api.mdx` and `upgrading.mdx`.

The committed `public/llms*.txt` are gone. Do not re-add them: a file in `public/` wins over nothing and rots in silence, which is the whole bug.

### A Hand-Maintained List That Mirrors Code Will Be Wrong

The 2026-07-30 post-release docs audit found the same defect in three files: `reference/api.mdx` documented 60 of 96 API routes, `concepts/audit-trail.mdx` listed 47 of 56 audit event types, and `concepts/agent-permissions.mdx` — the canonical "what can an agent do" page — never mentioned `knowledge_search`, the tool behind the release's headline feature. Three whole feature families (Automations, OpenAI-compatible providers, IMAP) had shipped with no reference entry at all.

The control group is the argument: `contracts.tools` did **not** drift, because `manifest-tools-drift.test.ts` guards it. The one list with a guard is the one list that stayed correct. Diligence does not scale; a diff does.

So every docs list that mirrors something derivable from code now has one:

- **`scripts/lib/docs-coverage.test.mjs`** — every API route appears in the API reference, **method and path**. That pairing matters: the audit's own manual pass compared paths only, and therefore missed `PUT /api/enterprise/key` documented as `POST`, and a whole Domain Lock section documenting a `PUT` that does not exist (the route is `POST` + `DELETE`, and its response fields were wrong too). It also checks that every `AuditEventType` appears in the audit-trail reference and every grantable tool in the permissions reference. Reading BOTH the tool registry and the plugin manifests is load-bearing — `knowledge_search` is in no registry, it reaches an agent only through the Knowledge Base template, so a registry-only check would have kept missing exactly the tool that went undocumented.
- **Both directions, because the worse one is docs → code.** `findGhostEndpoints` fails on a documented endpoint no handler serves. A code → docs check is structurally blind to it — the Domain Lock section's real `POST` and `DELETE` were both documented, so that half read green while the section as a whole described a `PUT` that never existed. Running the reverse check for the first time found one still live: `POST /api/settings/providers`, complete with a request-body table naming a `baseUrl` and an `isDefault` the real route (`POST /api/setup/provider`) has never accepted. An undocumented endpoint costs a reader a grep; a documented one that isn't there costs them an afternoon.
- **`scripts/lib/docs-consistency.test.mjs`** — no docs page is orphaned from the sidebar (`security/secrets.md` was reachable only from inline links for months); every `Settings → X` names a tab that exists (four pages still said "Settings → Providers" after the rename to "AI Provider" — one commit had claimed to align them all); and every forward-looking promise cites a tracking issue.

Both run under `pnpm test:scripts` in the `quality` job — no new CI wiring, no docs build needed.

Three rules keep them honest. **Exemptions carry a reason and are themselves checked**: an exemption naming a route, event, or tool that no longer exists fails, because a stale exemption is the same drift one level up. **Each check asserts it found a real corpus** (`handlers.length > 50`) — a broken walker that finds nothing would otherwise pass in silence, which is how a coverage gate becomes decoration.

And **an extractor throws on input it cannot read, rather than returning a short list**. A corpus floor only catches a walker that finds _nothing_; it is useless against one that finds most things. `extractAuditEventTypes` matched two dot-separated segments and so dropped all three `file.upload.*` events — 61 of 64 checked, `> 40` satisfied, silent. It now asserts that every quoted member the union declares came back, so a new event shape is an error instead of an omission. For the same reason, "is it documented?" is a whole-word match and not `String.includes`: a page mentioning `user.invite_blocked` must not count as documentation of `user.invite`.

#### Forward-looking claims need an issue, for the same reason skips do

A script cannot know whether "a progress UI is planned for a later phase" is still true — and it wasn't: the progress UI had shipped, and the same page described it 120 lines earlier. So the check does not judge the claim. It requires the sentence to **name a tracking issue**, which converts an un-checkable promise into a checkable one: a closed issue behind a "planned" sentence is a doc describing a world that no longer exists. Same contract as § "No Untracked Test Skips" — the issue number is what makes the promise auditable.

Keep `FORWARD_LOOKING_PHRASES` narrow. It matches commitments ("on the roadmap", "in a later phase"), never descriptions of the present: an invite "not yet claimed" and an upload "not yet part of a conversation" are ordinary prose, and a check that flags those gets switched off within a week.

The payoff is the weekly `docs-freshness.yml` cron: it takes the issues those sentences cite, asks GitHub which have closed, and reports the docs still promising something the repo already shipped. A cron rather than a PR gate on purpose — the question needs the network, the answer changes without anyone touching the repo, and a check that can go red between two identical commits does not belong in front of a merge button. A claim citing several issues is stale only when they are **all** closed, and an issue the API could not answer for counts as unknown, never as closed.

### A User-Visible Change Needs A Docs Change

The bullet above ("when behavior changes, update docs in the same PR") has been in this file for as long as it has existed, and nothing enforced it. `scripts/check-docs-required.mjs` does now, PR-only in the `quality` job — the same shape as the test-deletion guard.

It fails when a PR touches a **user-visible surface** and no file under `docs/`. The surfaces are listed in `scripts/lib/docs-required.mjs`: an API route, the tool registry, an agent template, the audit event catalogue, the settings navigation, a plugin's declared tools. Deliberately **not** every source file — a guard that fires on refactors gets an escape hatch typed into it reflexively, and then it guards nothing. Run against the three commits that actually caused the v0.9.0 drift (the Automations management API, the OpenAI-compatible delete route, the IMAP test endpoint), it fires on all three.

The escape hatch is the `docs-not-needed` label, or a commit trailer:

```
Docs-not-needed: gateway-only ingress, no reader-facing path
```

A written reason, **not** an issue number — and that difference from the skip and test-deletion guards is deliberate. A skip _defers_ work, so it needs somewhere for the work to live. "No docs needed" _asserts a fact_, and the useful artefact is the assertion itself, sitting in the history next to the change it describes. An issue number here would be a placeholder for an issue nobody ever opens. Bare non-answers (`n/a`, `none`) are rejected by length.

What this guard cannot do is check that the docs change is the _right_ one. That is `review-docs`'s job.

### Some Docs Checks Can Only Be Read, Not Run

The CI guards find missing **identifiers**. They cannot read a sentence, and the four worst findings of the v0.9.0 audit were all sentences:

- `GET /api/settings/domain` was documented with the wrong **response fields** — path and method both correct, body fiction.
- A page promised "a progress UI is planned for a later phase" while **describing the shipped progress UI 120 lines earlier**.
- "Agent templates and default permissions" listed **2 of ~35** templates, with the wrong tools on the row that mattered.
- A live guide said "Pinchy will not silently re-assign agents" about code that does exactly that.

The `review-docs` skill (`.claude/skills/review-docs/`) is that reading pass: scope the behaviour change, grep the docs for the thing **and its consequences**, then check the claim, the specifics (response fields, status codes, defaults, limits — wrong far more often than names are), self-contradiction within a page, and contradiction across pages. It also asks the one question no guard asks: does a doc describe something the code **no longer has**?

It is deliberately not a CI job: it wants the whole repo in context and produces prose the author acts on immediately, not a bot comment on a diff.

#### The skill has a trigger, because an instruction is not one

"Run this before opening a PR" is the same kind of sentence as "update docs in the same PR" — the one that sat in this file for a year while three feature families shipped undocumented. So the skill does not rely on being remembered.

`.claude/settings.json` registers a `PreToolUse` hook on `Bash(gh pr create*)` → `scripts/hooks/require-docs-review.mjs`. It diffs the branch against the PR's base, reuses `analyzeChangedPaths` from the docs-required guard, and **denies the tool call** — with the list of surfaces and what to do about it — unless one of these holds:

- the branch moved no user-visible surface (a docs-only or internal PR is never blocked);
- a review is recorded for **this exact HEAD sha**;
- a `Docs-not-needed:` trailer is in the branch's commits — the same escape hatch the CI gate honours, so one decision is recorded once.

`scripts/mark-docs-reviewed.mjs` writes the marker, and writes the HEAD sha into it. Land another commit and the recorded sha stops matching, so the review expires with the state it reviewed. The marker lives at `git rev-parse --git-path pinchy-docs-review` — untracked, per-worktree, and resolved that way rather than as a literal `.git/…` because inside a worktree `.git` is a file pointing elsewhere.

Two properties worth keeping if you touch it:

- **It fails open.** A hook that breaks must never make it impossible to open a pull request. Unreadable payload, unresolvable base, git not answering — all of them `allow`.
- **It is not a security boundary and does not pretend to be.** An agent can write the marker without reading a line, exactly as a human can `git push --no-verify`. It exists to make _forgetting_ impossible, which is the failure mode that actually happens.

### The Deployed Docs Are The Release Branch, Not `main`

`docs.yml` is manual-only; the real deploy path is `release.yml` → `screenshots.yml`, checked out at the tag. So **a docs fix merged to `main` is not live until the next release**, and a correction that belongs to the shipped version has to be backported like any other fix.

The v0.9.0 audit found exactly one live-docs error this way: the provider-removal section on `release/0.9` said "Pinchy will not silently re-assign agents", while v0.9.0's `DELETE /api/settings/providers` calls `migrateAgentsOffDeletedProvider` and does precisely that. The corrected wording had been on `main` since before the cut and was never carried over.

At release time, diff `docs/` between the release branch and `main` and classify every hunk: **main-only feature** (leave it) or **correction that applies to the shipped version** (backport it). The `cut-pinchy-release` skill carries this as a step.

Do not "fix" this by deploying docs from `main` instead. Pinning the docs to the release is what makes them describe the software users actually run; the cost is a backport, and the backport is the cheaper half.

`docs.yml`'s manual dispatch takes a required `pinchy_version` input for the same reason: without it, `inject-version.sh` falls back to `packages/web/package.json`, which on `main` still carries the _previous_ release — so an "urgent typo fix" dispatched from `main` would publish install instructions pinned to an older image than the one users can run.

**Verify a change to either gate with a canary, never by reading the code.** For anchors: add a link to a heading that does not exist, build, confirm the check fails on that exact link, remove it. For tables: set `gfm: false` in `docs/astro.config.mjs`, build, confirm `check:rendered` fails and names an affected route, set it back. The anchor canary is what caught `starlight-links-validator` being a no-op; nothing cheaper would have, and a passing unit suite would not have — these checkers are only ever proved by a real broken page.

Unrelated to the anchors but found while building them: `pnpm -C docs build` now runs `scripts/with-restore.sh astro build` rather than `astro build && restore`. The old `&&` chain short-circuited, so a failed or interrupted build left `vX.Y.Z` injected into the six committed source files `inject-version.sh` touches — and stayed that way, because the next run found no placeholders to inject and therefore registered nothing to restore. The wrapper restores either way and forwards the exit code.

What it does **not** cover, so nobody reads the green check as more than it is: only `<a href>` elements, never `<img src>`. Every `![…](/screenshots/….png)` is still checked by nothing — and has to be, because `docs/public/screenshots/` is written by `screenshots.yml` at release time and does not exist in a normal checkout, so checking it would fail every build rather than catch anything. External links out of `docs/` remain unchecked too; that is the `--exclude-path docs` half this did not close.

## Product Context

Pinchy's core differentiator is agent permissions and control: granular agent permissions, RBAC, audit trail, and self-hosted governance. Multi-user support alone is not the value proposition.

Competitor context:

- Cloud SaaS such as Dust, Glean, and StackAI: data leaves the company.
- Workflow builders such as n8n and Dify: visual step chains, not autonomous agents.
- Vendor suites such as Copilot Studio and Google AgentSpace: proprietary and model-constrained.
- Frameworks such as CrewAI, LangChain, and AutoGen: libraries, not platforms.
- OpenClaw: strong runtime, missing enterprise governance.

Useful external references:

- Pinchy docs: https://docs.heypinchy.com
- OpenClaw docs: https://docs.openclaw.ai
- Pinchy website: https://heypinchy.com

## Agent-Specific Notes

- This file is the canonical repository instruction file for coding agents.
- Keep instructions concise enough for Codex to load comfortably. If a package needs detailed local rules, add a nested `AGENTS.md` or `AGENTS.override.md` near that package.
- `CLAUDE.md` is only a compatibility pointer for Claude-style tools. Do not maintain a second copy of these instructions there.
