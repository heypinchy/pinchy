# AGENTS.md - Pinchy

## Purpose

Pinchy is an enterprise AI agent platform built on top of OpenClaw. OpenClaw is the agent runtime; Pinchy adds the enterprise layer: permissions, audit trails, user management, governance, and deployment.

Status: early development. The core is working: setup wizard, authentication, provider configuration, OpenClaw-backed agent chat, allow-listed agent permissions, knowledge base agents, user invites, personal/shared agents, per-user/org context, Smithers onboarding, audit trail, Telegram channel integration, and Docker Compose deployment. Granular RBAC, plugin marketplace, and more channel integrations are planned.

## Repository Map

- `packages/web/` - Next.js app, API routes, WebSocket bridge, Drizzle schema/migrations, tests.
- `packages/plugins/` - OpenClaw plugins. Current Pinchy plugins: `pinchy-files`, `pinchy-context`, `pinchy-docs`, `pinchy-audit`, `pinchy-email`, `pinchy-odoo`, `pinchy-transcript`, `pinchy-web`, `pinchy-knowledge`, `pinchy-approvals`. Guarded against the directory listing by `scripts/lib/agents-md-repository-map.test.mjs`.
- `packages/openclaw-runtime/` - Manifest-only workspace package: the OpenClaw version the `pinchy-openclaw` image ships. `Dockerfile.openclaw` installs it from `pnpm-lock.yaml` with `--frozen-lockfile`, so OpenClaw's own tree in the image is the one `vuln-scan` checks and the root `pnpm.overrides` apply to it — the llama-cpp provider and the `/opt/pinchy-*-deps` bundles in the same image are still npm installs no lockfile covers. Never `npm install -g openclaw` — that honours OpenClaw's own npm-shrinkwrap.json and bypasses both. `openclaw-version-pin-drift.test.ts` pins the install shape (including `strict-dep-builds`: a dependency install script not listed in `pnpm.onlyBuiltDependencies`/`ignoredBuiltDependencies` fails the image build) and keeps the version in lockstep with `packages/web`; `openclaw-runtime-closure.test.ts` fails when an override pushes a runtime dependency outside the major its dependent declares.
- `config/` - OpenClaw config support, startup scripts, mock services for integration/E2E tests.
- `docs/` - Astro Starlight documentation. It is standalone and has its own `package.json` and lockfile.
- `plans/` - Design and implementation records for larger features, committed on purpose: the reasoning behind a decision outlives the PR that carried it, and a review that revisits one needs it. Not to be confused with `docs/plans/`, which `.gitignore` drops — those are scratch, these are the record.
- `sample-data/` - Sample knowledge-base data mounted into Docker at `/data/`.
- `marketplace/` - 1-Click deploy templates (DigitalOcean Packer image, CapRover one-click). Version-pinned to the release and guarded by `scripts/lib/marketplace-version.test.mjs` + `marketplace-lint.test.mjs`.
- `docker-compose*.yml` - Development, production, integration, and E2E stack definitions.
- `PERSONALITY.md` - Brand voice guide. Read before writing user-facing UI or docs copy.
- `.claude/skills/designing-pinchy-features/` - Interaction design playbook. Read before building a create form, config dialog, wizard, settings tab, or onboarding step — it decides what the UI asks versus what Pinchy derives.

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

## Topic Rules

Rules that matter only when touching one area live in `agent-rules/`, one file per topic. They are not loaded with this file: read the file **before** you start work that matches its trigger. A `§ "Heading"` reference in code, a comment or one of these files names a section heading — search `agent-rules/` for it.

- `agent-rules/testing.md` — before skipping, deleting or rewriting a test, writing an E2E wait, changing where a feature reads its data from, adding a type-level or jsdom test, or running the full suite.
- `agent-rules/ci.md` — before changing anything under `.github/workflows/` or `.github/actions/`.
- `agent-rules/release.md` — before editing `docs/src/content/docs/guides/upgrading.mdx`, any declared version (`package.json`, `.env.example`, the README quick start, `marketplace/`), or the release scripts.
- `agent-rules/dependencies.md` — before bumping a dependency or Node, accepting a vulnerability (`osv-scanner.toml`, `pnpm.auditConfig`), or editing a Dockerfile.
- `agent-rules/tooling.md` — before touching `.husky/`, lint-staged, a prettier config or `.prettierignore`, or when a pre-commit or pre-push hook fails.
- `agent-rules/dev-stack.md` — before editing a `docker-compose*.yml` file or running a dev stack in a worktree.
- `agent-rules/web-routes.md` — before adding or changing an API route, a request schema, a client-side `fetch`, `next.config.ts` headers, or anything under `/api/internal/`.
- `agent-rules/ui.md` — before building a create form, config dialog, wizard, settings tab or onboarding step, or deciding how an error is shown.
- `agent-rules/secrets.md` — before handling a credential, an API key or an `openclaw.json` value, or changing how a plugin fetches credentials.
- `agent-rules/plugins.md` — before changing anything under `packages/plugins/`, or adding a plugin or a tool.
- `agent-rules/docs.md` — before changing `docs/`, a user-visible surface or a docs check, and before opening a PR.
- `agent-rules/eval.md` — before committing eval data under `packages/web/eval/` or changing `model-resolver/blocklist.ts`.
- `agent-rules/issue-triage.md` — before changing `.github/workflows/issue-triage.yml`, `scripts/lib/issue-triage.mjs` or the in-app bug-report link.

The hard "never" rules, in one place. Each topic file holds the reasoning and the guard behind them:

- Never skip a test (`.skip`, `.todo`, `.fixme`, `xit`, `xdescribe`) without a `#NNN` tracking issue next to it, remove tests on net without `Allow-test-deletion: #NNN`, or weaken a test to make reduced code pass. → `testing.md`
- Never call `page.waitForTimeout` in `e2e/**` without a `#NNN` comment directly above it. → `testing.md`
- Never edit a released `## Upgrading from …` section of `upgrading.mdx`. → `release.md`
- Never put `paths-ignore`/`paths` on `ci.yml`'s triggers, a matrix on a required job (`quality`, `vitest-integration`, `e2e`), or `timeout-minutes` on a job that calls a reusable workflow. Every other job sets `timeout-minutes`. → `ci.md`
- Never put a session-authed route under `/api/internal/`, or send a mutating `fetch` from client code instead of `api-client.ts`. → `web-routes.md`
- Never put a third-party credential, or a SecretRef to one, into a plugin's config block in `openclaw.json`. → `secrets.md`
- Never ship a plugin `fetch()` without a `signal`, or a failing tool result without `details.error`. → `plugins.md`
- Never change a user-visible surface without touching `docs/` or adding a `Docs-not-needed:` trailer. → `docs.md`

## Commands

Development should use Docker Compose because the app depends on PostgreSQL, OpenClaw, and migrations:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

That stack is **already** an enterprise install: `docker-compose.dev.yml` defaults `PINCHY_ENTERPRISE_KEY` to the development license (`DEV_LICENSE_TOKEN`, `packages/web/src/lib/license-keys.ts`). It is signed by a key only a non-production build trusts, so committing it unlocks nothing on anyone's install — which is the point, and the fix for #1083. The production-signed token that used to sit there did unlock every install, and no test could see it, because a valid key makes every test pass.

To see the community experience instead, set the variable to something empty — Compose only substitutes its default when the variable is **unset**, not when it is empty:

```bash
PINCHY_ENTERPRISE_KEY= docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Two rules keep this honest, both guarded by `packages/web/src/__tests__/security/committed-license-tokens.test.ts`:

- **No token in the tracked tree may verify against the production key.** The guard asks jose directly rather than going through `validateLicense`, so it fires even on a token our own policy would reject — the question is whether we signed it, not whether we would grant it.
- **The development subject is never honoured under the production key** (`DEV_LICENSE_SUBJECT`, `packages/web/src/lib/license.ts`). That rule, not the rotation of any key, is what revokes the token in this repository's history — it is in every clone and every fork and cannot be un-published. Changing the string un-revokes it; a test pins the value for exactly that reason.

Production-style run:

```bash
docker compose pull && docker compose up -d
```

Common host commands from the repository root:

```bash
pnpm test
pnpm test:related
pnpm test:libreoffice
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

`scripts/lib/agents-md-commands.test.mjs` (run by `pnpm test:scripts`) keeps these blocks honest: it walks every `pnpm` command in this file and in `agent-rules/`, resolves each to the package it runs in — handling `-C`/`--dir`/`--filter`, `cd x && pnpm y` chains, `pnpm run <script>`, and pnpm builtins like `install` — and fails if the script isn't declared there. That drift is how `pnpm lint`, `pnpm format` and `pnpm db:generate` sat here for months as root commands that never existed. Nothing else in CI reads this file.

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
- Keep this file lean: it is loaded into every session and every subagent. A rule that matters only when touching one area belongs in `agent-rules/`, linked from § "Topic Rules" with the trigger for reading it. `scripts/lib/agents-md-topics.test.mjs` fails on an unlinked topic file, a link to a missing one, and this file growing past its size budget.
- `CLAUDE.md` is only a compatibility pointer for Claude-style tools. Do not maintain a second copy of these instructions there.
