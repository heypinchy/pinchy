# AGENTS.md - Pinchy

## Purpose

Pinchy is an enterprise AI agent platform built on top of OpenClaw. OpenClaw is the agent runtime; Pinchy adds the enterprise layer: permissions, audit trails, user management, governance, and deployment.

Status: early development. The core is working: setup wizard, authentication, provider configuration, OpenClaw-backed agent chat, allow-listed agent permissions, knowledge base agents, user invites, personal/shared agents, per-user/org context, Smithers onboarding, audit trail, Telegram channel integration, and Docker Compose deployment. Granular RBAC, plugin marketplace, and more channel integrations are planned.

## Repository Map

- `packages/web/` - Next.js app, API routes, WebSocket bridge, Drizzle schema/migrations, tests.
- `packages/plugins/` - OpenClaw plugins. Current Pinchy plugins: `pinchy-files`, `pinchy-context`, `pinchy-docs`, `pinchy-audit`, `pinchy-email`, `pinchy-odoo`, `pinchy-transcript`, `pinchy-web`.
- `config/` - OpenClaw config support, startup scripts, mock services for integration/E2E tests.
- `docs/` - Astro Starlight documentation. It is standalone and has its own `package.json` and lockfile.
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

Permanent test skips need a tracking issue. The ESLint rule `pinchy/no-untracked-skips` and the vitest drift-guard `src/__tests__/lib/no-untracked-skips.test.ts` both enforce this — they fire on `test.skip`, `it.skip`, `describe.skip`, `.todo`, `.fixme`, `xit`, `xdescribe` unless the immediately surrounding 40 lines contain a tracking-issue reference (`#NNN` or a github.com/.../issues/NNN URL). A third guard, `no-untracked-skips-parity.test.ts`, pins the two checkers together: if you teach one a new skip syntax and forget the other, the parity fixtures will flag the drift.

Two patterns are explicitly allowed:

- **`describe.skipIf(condition)` / `it.skipIf(condition)`** — conditional gates driven by env vars or OS features (e.g. `describe.skipIf(!process.env.INTEGRATION_TEST)`). These are not "we'll come back to it later" suppressions.
- **Any banned form (`.skip`, `.todo`, `.fixme`, `xit`, `xdescribe`) with `#NNN` in the leading comment block** — the issue is the contract. "Tracked separately" / "follow-up" / inline TODO without a number is not enough. `it.todo("…")` is treated exactly like `.skip` — it silently turns green in CI but never runs, which is precisely the failure mode this policy exists to stop.

If a check is in your way and you can't fix it in scope, **file the issue first**, link the number, then skip. Don't ship the skip with a promise to file the issue later — the 2026-05-22 audit found five clusters where exactly that happened, one of them hiding a production password-reset bug.

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

## Test Migrations Against Pre-Existing Data

When you change **where a feature reads its data from** — a new table, a new store, a different source (e.g. the Telegram mirror switching from OpenClaw `chat.history` to Pinchy's `channel_messages`) — you MUST add a test that reads data written by the **old** source with the **new** code.

This is the read-side sibling of the test-skip/test-deletion guards: it forces a conscious decision about migration (backfill, fallback, or accept-and-document) instead of silently dropping data created before the switch.

The trap is that every test starts from a clean slate where the new mechanism is live from the first write, so a green suite proves nothing about the state a real **upgrade** produces (old data, new code). The 2026-06 Telegram regression shipped exactly this way: the source switch blanked every conversation that predated the capture plugin, and the existing Telegram E2E stayed green because it only ever exercised freshly-captured conversations.

Concretely:

- **Simulate the pre-existing state:** let the new path capture/write, then delete those rows for the entity, then assert the feature still works (it must fall back or have been backfilled). See `deleteCapturedTelegramMessages` + the "listed ⟹ readable" test in `packages/web/e2e/telegram/chats.spec.ts`, and the deterministic route-level equivalent in `packages/web/src/__tests__/api/agent-telegram-chat.test.ts`.
- **Assert the cross-route invariant**, not just one route in isolation: if an item appears in a list, opening it must show content (or a defined, honest empty state). List and detail are often changed independently.

## No Unread Catastrophic Eval Cell

The Eval-v1 dataset (`packages/web/eval/data`) is committed evidence, and evidence nobody reads protects nobody. The 2026-07-11 sweep measured `minimax-m3` at 0/12 on the line-items scenario — the only one that needs nested-array tool arguments. Four days later a production agent failed to book invoices on that model, for that defect (#766). The number was in the repo the whole time; nothing wired it to `model-resolver/blocklist.ts`.

`packages/web/eval/__tests__/scorecard-triage-guard.test.ts` is the wire. It runs in vitest against the checked-in dataset (~2s, no docker stack, no API keys — `pnpm eval:models` needs both, and CI runs only `eval:selftest`), so it gates every PR, including the one that commits a fresh sweep. It judges the **published** numbers, via `buildPublishedScenarios()` from `eval/export-scorecard.ts` — not the stored `data/<scenario>.json` scorecards, which three re-graded scenarios have since diverged from.

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

Related: the images are built by a `build-images` **matrix** (two runners, ~2× faster than the old serial job) and fanned back in through `build-image`, whose only job is to preserve the `result` + `outputs` contract the 11 downstream jobs already encode. Its `if:` mirrors the matrix's verbatim, and `!cancelled()` plus its guard step is what keeps a *failed* build from reading as `skipped` — which downstream would take as "fork PR, build locally" and cheerfully rebuild a Dockerfile CI just proved broken. Because a matrix cannot export per-entry outputs, the fan-in recomputes the tags; `scripts/lib/ci-image-tags.test.mjs` pins the two expressions together.

## Web Test Files Are Type-Checked

`packages/web` test files (`*.test.ts(x)`, `*.integration.test.ts`, `*.test-d.ts`) are type-checked in CI by the `quality` job's "Typecheck web (incl. tests)" step: `pnpm -C packages/web typecheck` → `tsc --noEmit -p packages/web/tsconfig.typecheck.json`.

This exists because `next build` type-checks the web package but its `tsconfig.json` deliberately **excludes** `src/**/*.test.ts(x)`, and vitest runs without `--typecheck`. So test-file type errors — including dormant `expectTypeOf`/`assertType` assertions that silently pass as runtime no-ops — went undetected until this gate landed. `tsconfig.typecheck.json` extends the base config but INCLUDES the test files and adds `vitest/globals` + `@testing-library/jest-dom` to `types`.

- Write genuine type-level tests: `expectTypeOf(...).toEqualTypeOf<T>()` / `.toExtend<T>()` are now real compile-time checks. Do NOT paper over failures with `as any` / `@ts-expect-error`.
- Shared, correctly-typed test helpers live in `packages/web/src/test-helpers/` (`auth.ts` → `mockSession`, `route.ts` → `makeNextRequest`/`routeContext`, `fixtures.ts` → `makeAgent`/`makeTemplateItem`). Prefer them over inline fixtures so a type change is a one-line helper fix, not a sweep across test files.
- The drift guard `scripts/lib/web-typecheck-gate.test.mjs` (pure logic in `web-typecheck-gate.mjs`, run by `pnpm test:scripts`) fails if the tsconfig stops including test files, re-excludes them, the `typecheck` script drifts, or CI stops running the gate — the read-side sibling of the no-untracked-skips / no-test-deletion / plugin-typecheck guards.
- Playwright `e2e/**/*.spec.ts` is intentionally out of this gate (separate Playwright type context).

## One Format Gate, Whole-Tree, From The Root

There is exactly **one** format gate: `pnpm format:check` → `prettier --check .`, run from the repo root by the `quality` job. `pnpm format` writes. Prettier is declared **once**, in the root `package.json`, and nowhere else.

Until 2026-07 the gate was `pnpm --filter @pinchy/web format:check` — a check named "Format check" that only ever read `packages/web`. Everything else had never been formatted and nothing said so: `scripts/` (28 files), every plugin (56), the `config/` mock servers, the compose overlays, `docs/scripts/`. **The check was green the whole time**, because a gate reports on what it looks at, not on what it should look at. That is the same failure shape as a `paths-ignore` on a required check, arriving through the config instead of the trigger.

The rules that keep it honest:

- **Whole-tree (`.`), never a glob list, never `--filter`/`-C` delegation.** Both narrow the gate silently, and both are the original bug spelled differently. What is excluded belongs in `.gitignore`/`.prettierignore` — one place, not a list in a script that rots as directories are added.
- **`.prettierignore` must repeat what NESTED `.gitignore` files say.** Prettier reads only the **root** `.gitignore`; `docs/.gitignore` and `packages/web/.gitignore` are invisible to a run started from the root. Add a generated directory to a nested `.gitignore` → add it to `.prettierignore` too, or `pnpm format` reformats build output.
- **One prettier declaration.** Two can resolve to two versions, which format the same file differently — then somebody's local `pnpm format` always loses to the gate.
- **`pnpm format` is not guaranteed to converge in one pass.** Prettier is not idempotent on every input (`config/llm-providers-mock/server.js` reflows a method chain differently on pass 1 and pass 2). The tree is committed at a fixed point; if `format:check` still complains right after `format`, run `format` again before assuming the gate is broken.
- The drift guard is `scripts/lib/format-gate.test.mjs` (pure logic in `format-gate.mjs`, run by `pnpm test:scripts`). Its most important assertion is not the wiring but the **coverage probe**: it resolves prettier's real ignore rules against one file per tree and fails if any is excluded. A single well-meaning `scripts/` line in `.prettierignore` reverts the whole gate while every check stays green — that is the one mutation the wiring checks cannot see.

### Two styles, and why the boundary sits at `packages/`

There is deliberately **no root `.prettierrc`**. `packages/.prettierrc` (printWidth 100, `trailingComma: es5`) governs **all** app TypeScript — `packages/web` **and** `packages/plugins/*`. Everything else — `scripts/`, `config/`, `docs/`, the compose files, `.github/` — uses prettier's defaults (printWidth 80, `trailingComma: all`), which is what those files were already written in. This is a **coverage** gate, not a style-unification: a root config in the web style would re-wrap 23 files that are green today, which is a separate change with a separate argument.

The config sits at `packages/`, not `packages/web/`, and that is load-bearing rather than tidiness. `normalizeTableHtml` is **duplicated on purpose** across `packages/plugins/pinchy-files/docx-extract.ts` and `packages/web/src/hooks/use-ws-runtime.ts` (bundle isolation), and `normalize-docx-table-html-drift.test.ts` pins the two bodies to be textually identical modulo whitespace and comments. With the config one level down, the plugin copy formatted at `trailingComma: all` and the web copy at `es5` — a **token** difference, not a whitespace one, so the guard went red the moment the plugins entered the gate. Any style split that cuts through duplicated-by-design code will do that again. If a future duplication crosses a different boundary, move the config up — do not weaken the guard.

`docs-format.yml` used to check docs and workflows separately, because `ci.yml` once carried a workflow-level `paths-ignore` and skipped docs PRs. It no longer does (see above), and `quality` is ungated — so the root gate covers those files on every PR and the extra workflow was removed rather than left to duplicate it.

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

Common host commands from the repository root:

```bash
pnpm test
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
9. No plaintext PII appears in audit `detail`.

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
- The plugin lazily fetches credentials from `GET /api/internal/integrations/:connectionId/credentials` using the gateway token as Bearer auth.
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

### Tool dispatch coverage

Every plugin tool must be covered at three layers:

1. **`openclaw.plugin.json#contracts.tools`** — list every tool name. OpenClaw 5.3+ silently ignores `registerTool()` calls that are not declared here. The bidirectional drift guard (`manifest-tools-drift.test.ts`) enforces that this list matches the `registerTool()` calls in `index.ts`.

2. **Drift guard** — `packages/web/src/__tests__/lib/manifest-tools-drift.test.ts` checks that `contracts.tools` and `registerTool()` are in sync. Runs in `pnpm test`.

3. **Behavior test** — at least one tool per plugin must have an E2E test that:
   a. Sends a chat message containing a trigger string handled by `fake-ollama-server.ts`.
   b. The fake LLM returns a deterministic `tool_calls` response for that tool.
   c. The test asserts the audit entry appears, either via a literal `/api/audit?eventType=tool.<toolName>&limit=10` query or via the shared `pollAuditForTool({ toolName, agentId })` helper in `packages/web/e2e/shared/dispatch-probe.ts`.

   The coverage guard (`plugin-tool-coverage.test.ts`) scans all `*.spec.ts` files for both `eventType=tool.<toolName>` and `pollAuditForTool(... toolName: "<toolName>" ...)` patterns. If a plugin has tools but no matching E2E assertion, CI fails there.

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
