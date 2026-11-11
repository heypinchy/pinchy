# Testing

Read this before skipping, deleting or rewriting a test, writing an E2E wait, changing where a feature reads its data from, adding a type-level or jsdom test, or running the full suite. Part of the agent rules indexed in `AGENTS.md` § "Topic Rules".

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
