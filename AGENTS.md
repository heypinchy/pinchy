# AGENTS.md - Pinchy

## Purpose

Pinchy is an enterprise AI agent platform built on top of OpenClaw. OpenClaw is the agent runtime; Pinchy adds the enterprise layer: permissions, audit trails, user management, governance, and deployment.

Status: early development. The core is working: setup wizard, authentication, provider configuration, OpenClaw-backed agent chat, allow-listed agent permissions, knowledge base agents, user invites, personal/shared agents, per-user/org context, Smithers onboarding, audit trail, Telegram channel integration, and Docker Compose deployment. Granular RBAC, plugin marketplace, and more channel integrations are planned.

## Repository Map

- `packages/web/` - Next.js app, API routes, WebSocket bridge, Drizzle schema/migrations, tests.
- `packages/plugins/` - OpenClaw plugins. Current Pinchy plugins: `pinchy-files`, `pinchy-context`, `pinchy-docs`, `pinchy-audit`, `pinchy-email`, `pinchy-odoo`, `pinchy-web`.
- `config/` - OpenClaw config support, startup scripts, mock services for integration/E2E tests.
- `docs/` - Astro Starlight documentation. It is standalone and has its own `package.json` and lockfile.
- `sample-data/` - Sample knowledge-base data mounted into Docker at `/data/`.
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
pnpm lint
pnpm format
pnpm db:generate
pnpm test:scripts
```

Useful web package commands:

```bash
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

Use toast notifications for completed actions, background/system errors, and actions that navigate away or close the dialog.

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
