# CLAUDE.md — Pinchy

## What is Pinchy?

Pinchy is an **enterprise AI agent platform** built on top of [OpenClaw](https://github.com/openclaw/openclaw). OpenClaw is the most powerful open-source AI agent runtime — but it's designed for individual power users. Pinchy adds the enterprise layer: permissions, audit trails, user management, and governance.

**Status: Early development.** The core is working — setup wizard, authentication, provider configuration, agent chat via OpenClaw, agent permissions (allow-list model), knowledge base agents, user management with invite system, personal and shared agents, per-user/org context management, Smithers onboarding interview, audit trail, Telegram channel integration, and Docker Compose deployment. Enterprise features (granular RBAC, plugin marketplace, additional channel integrations) are next.

### The Problem Pinchy Solves

Companies want AI agents but face a trilemma:
- **Cloud platforms** (Dust, Glean, Copilot Studio) → data leaves your servers. Non-starter for EU regulated industries.
- **Workflow builders** (n8n, Dify) → chain steps visually, but not autonomous agents.
- **Frameworks** (CrewAI, LangChain) → libraries, not platforms. No UI, no permissions, no deployment.
- **OpenClaw** → best agent runtime, but no multi-user, no RBAC, no audit trail.

### Target Architecture (PARTIALLY IMPLEMENTED)

```
┌─────────────────────────────────────────┐
│              Pinchy Platform             │
│                                         │
│  ┌──────────┐  ┌──────────┐  ┌───────┐ │
│  │ Web UI   │  │ REST API │  │ Admin │ │
│  └────┬─────┘  └────┬─────┘  └───┬───┘ │
│       │              │            │     │
│       │  ┌───────────────────┐    │     │
│       │  │ Channels          │    │     │
│       │  │ (Telegram, …)     │    │     │
│       │  └────────┬──────────┘    │     │
│       │           │               │     │
│  ┌────┴───────────┴───────────────┴───┐ │
│  │         Permission Layer           │ │
│  │  (RBAC, Scoped Tools, Audit Log)   │ │
│  └────────────────┬───────────────────┘ │
│                   │                     │
│  ┌────────────────┴───────────────────┐ │
│  │        OpenClaw Runtime            │ │
│  │  (Agents, Sessions, Channels,      │ │
│  │   Plugins, MCP, Memory)            │ │
│  └────────────────────────────────────┘ │
│                                         │
│  🔌 Plugin Architecture                │
│  🔐 Role-Based Access Control          │
│  📋 Audit Trail (IMPLEMENTED)          │
│  💬 Telegram Integration (IMPLEMENTED) │
│  🔀 Cross-Channel Workflows            │
│  🏠 Self-Hosted & Offline-Capable      │
│  🤖 Model Agnostic (OpenAI, Anthropic, │
│     Ollama, local models)              │
└─────────────────────────────────────────┘
```

### Core Concepts (planned and implemented)

- **Plugin Architecture** (partially implemented): Agents get scoped tools, not raw shell access. Seven plugins live in `packages/plugins/` today (plugin marketplace planned):
  - `pinchy-files` — read-only file access for Knowledge Base agents
  - `pinchy-context` — saves user/org context during Smithers onboarding
  - `pinchy-docs` — on-demand access to platform documentation (used by Smithers)
  - `pinchy-audit` — source-level tool execution audit logging for all OpenClaw tools
  - `pinchy-email` — Gmail integration (send/read)
  - `pinchy-odoo` — Odoo CRM integration
  - `pinchy-web` — web search (Brave) and web fetch
- **Agent Permissions** (implemented): Allow-list model — agents start with zero tools, admins grant specific capabilities. Safe tools (list/read approved dirs) vs. powerful tools (shell, write, web).
- **RBAC** (partially implemented): Admin/user roles with agent access control (admins see all, users see shared + personal agents). Granular per-team/per-role RBAC is planned.
- **Audit Trail** (implemented): Captures admin state changes, authentication events (`auth.login`/`auth.failed`/`auth.logout`/`auth.csrf_blocked`), agent tool executions and denials (`tool.<name>`/`tool.denied`, written by the `pinchy-audit` plugin via `/api/internal/audit/tool-use`), chat events (`chat.retry_triggered`), and audit exports (`audit.exported`). HMAC-SHA256 signed rows, integrity verification, CSV export. Compliance-ready.
- **User Management** (implemented): Invite system with token-based onboarding, admin and user roles, password management.
- **Knowledge Base Agents** (implemented): Scoped read-only access to specific directories. Template-based creation.
- **Smithers Onboarding** (implemented): New users get an onboarding interview — Smithers learns about them through conversation and saves their context via plugin tools. Admins are additionally asked about their organization.
- **Telegram Channels** (implemented): Admins set up Telegram in Settings → Telegram (guided flow with BotFather instructions, connects to Smithers). Additional agents can be connected via Agent Settings → Channels. Users link their Telegram account by scanning a QR code, messaging the bot, and entering a pairing code. Sessions are unified across web and Telegram via `identityLinks`. Config architecture: DB is source of truth, `regenerateOpenClawConfig()` writes the config file (both at startup and from routes after changes). OpenClaw detects file changes via internal file watcher and hot-reloads. No WebSocket RPC (`config.patch`) needed for config changes.
- **Cross-Channel Workflows**: Additional channels (email, Slack) and cross-channel routing are planned. Telegram is the first implemented channel.
- **Self-Hosted**: Your server, your data, your models. Works without internet.
- **Docker Compose Deployment**: Single `docker compose up` to run everything.

## Tech Stack

- **Frontend**: Next.js 16, React 19, Tailwind CSS v4, shadcn/ui, assistant-ui
- **State Management**: zustand
- **Auth**: Better Auth (email/password, DB sessions, Admin Plugin)
- **Database**: PostgreSQL 17, Drizzle ORM
- **Agent Runtime**: OpenClaw Gateway (WebSocket), openclaw-node client
- **Testing**: Vitest, React Testing Library, Playwright (E2E)
- **CI/CD**: GitHub Actions, ESLint, Prettier, Husky + lint-staged (pre-commit)
- **Security**: AES-256-GCM encryption (API keys), HMAC-SHA256 (audit trail), SBOM generation (Syft)
- **Deployment**: Docker Compose
- **Documentation**: Astro Starlight, deployed to [docs.heypinchy.com](https://docs.heypinchy.com)
- **License**: AGPL-3.0

## Project Structure

```
pinchy/
├── packages/
│   ├── web/               # Next.js app (frontend + API + WebSocket bridge)
│   │   ├── src/
│   │   │   ├── app/       # Pages & API routes
│   │   │   ├── components/ # React components (+ shadcn/ui + assistant-ui)
│   │   │   ├── db/        # Schema & migrations
│   │   │   ├── lib/       # Utilities (auth, setup, agents, encryption, audit)
│   │   │   ├── hooks/     # React hooks
│   │   │   └── server/    # WebSocket bridge (client-router, ws-auth)
│   │   ├── e2e/           # Playwright E2E tests
│   │   └── drizzle/       # Generated migrations
│   └── plugins/                    # OpenClaw plugins (each with openclaw.plugin.json)
│       ├── pinchy-files/           # Knowledge base file access (read-only)
│       ├── pinchy-context/         # Saves user/org context during Smithers onboarding
│       ├── pinchy-docs/            # On-demand docs lookup (Smithers reads docs at runtime)
│       ├── pinchy-audit/           # Tool-execution audit logging (calls Pinchy API)
│       ├── pinchy-email/           # Gmail send/read
│       ├── pinchy-odoo/            # Odoo CRM
│       └── pinchy-web/             # Brave search + web fetch
├── config/                         # OpenClaw config & startup script
├── sample-data/                    # Sample docs for dev/testing (mounted at /data/)
├── docs/                           # Documentation (Astro Starlight, standalone)
├── docker-compose.yml              # Full stack definition (production)
├── docker-compose.dev.yml          # Dev override (hot reload, exposed DB port)
├── docker-compose.test.yml         # Unit/component test stack
├── docker-compose.integration.yml  # Integration test stack
├── docker-compose.e2e.yml          # Playwright E2E stack
├── docker-compose.odoo-test.yml    # Mock Odoo for pinchy-odoo integration tests
├── Dockerfile.pinchy               # Production image
├── Dockerfile.pinchy.dev           # Dev image (no build step, runs pnpm dev)
├── Dockerfile.openclaw             # OpenClaw runtime image
├── .github/workflows/              # CI, docs deployment, SBOM generation
├── CLAUDE.md                       # ← You are here
├── PERSONALITY.md                  # Brand voice & tone guide (read before writing UI text)
├── CONTRIBUTING.md                 # Contribution guidelines
├── SECURITY.md                     # Security policy & vulnerability reporting
└── README.md                       # Public-facing project description
```

## Development Guidelines

### Code Style
- TypeScript strict mode
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`
- One feature/fix per PR, small and focused
- **Test-Driven Development (TDD)**: Write the failing test first, then the implementation. No exceptions.
- Tests for all new features
- Update docs when behavior changes — Smithers reads the docs on demand via the `pinchy-docs` plugin (`docs_list` / `docs_read`), so docs are the single source of truth for platform knowledge.

### Architecture Principles
- **OpenClaw is the runtime** — don't reinvent what OpenClaw already does. Wrap it, extend it, govern it.
- **Plugin-first** — every integration should be a plugin, not hardcoded
- **Offline-first** — must work without internet (local models via Ollama)
- **API-first** — every UI action maps to a REST endpoint
- **Self-hosted** — no phone-home, no telemetry unless opt-in

### Audit Trail Guidelines
The audit log captures more than just admin state changes — it also records auth events, agent tool calls (written by the `pinchy-audit` OpenClaw plugin via `POST /api/internal/audit/tool-use`), chat retries, and audit exports. The full event-type union lives in `AuditEventType` in `@/lib/audit`.

Every state-changing API route MUST log via `appendAuditLog()` (or one of the variants below) unless explicitly marked `// audit-exempt: <reason>`. The `detail` JSON field must follow these rules:

- **Never fire-and-forget.** `appendAuditLog(...).catch(console.error)` is forbidden by ESLint (`pinchy/require-audit-log` rule, see #231) — silently swallowed audit failures break the compliance contract. Pick one of three patterns:
  - `await appendAuditLog(...)` — preferred for **idempotent** state changes (PUT/PATCH/DELETE on existing resources). If the audit write fails, the route returns 500 and the client retries — same end state.
  - `deferAuditLog(...)` from `@/lib/audit-deferred` — for **non-rollbackable** side effects that already happened (POST creating a row, OAuth tokens persisted, schema synced). Wraps `after()` so the audit runs after the response. Failures increment a process-wide counter and emit a structured `event: "audit_log_write_failed"` JSON line. Request scope only — throws outside route handlers.
  - `try { await appendAuditLog(...) } catch (err) { recordAuditFailure(err, entry) }` — for **WebSocket / cron / non-request contexts** where `after()` isn't available. Same structured failure signal as `deferAuditLog`, but synchronous and never throws.
- **Every `appendAuditLog` call must specify `outcome: 'success' | 'failure'`.** TypeScript enforces this at the call site. For events that by construction represent a completed action (`*.created`, `*.updated`, `*.deleted`, `auth.login`, `auth.logout`, `config.changed`, etc.), pass `outcome: 'success'`. For intrinsic-failure events like `auth.failed` and `tool.denied`, pass `outcome: 'failure'` and an `error: { message }` object describing why.
- **Snapshot human-readable names alongside IDs.** IDs alone are useless after an entity is deleted. Always include `{ id, name }` pairs for referenced entities (groups, users, agents).
- **Log what changed, not just that something changed.** Bad: `{ changes: ["visibility"] }`. Good: `{ changes: { visibility: { from: "all", to: "restricted" }, allowedGroups: { added: [{ id, name }], removed: [{ id, name }] } } }`.
- **Use added/removed diffs for membership changes.** Don't just log the final count — log who/what was added and removed with `{ id, name }` pairs.
- **Include the resource name in the detail** for delete events (the resource itself won't be queryable after deletion).
- **Keep detail under 2048 bytes** (larger payloads are auto-truncated with `_truncated: true`). For bulk operations with many items, summarize if needed.
- **Never write plaintext email addresses (or other PII) into `detail`.** The audit log is HMAC-signed and append-only — once an email lands in detail, GDPR Art. 17 erasure conflicts with row integrity. For events that need to identify a recipient/login attempt, spread `redactEmail(email)` from `@/lib/audit` (gives an `emailHash` + masked `emailPreview`). For `user.deleted` and similar events where the userId is already in `resource`, log only the display name. The ESLint rule `pinchy/no-pii-in-audit-detail` flags `email:` / `emailAddress:` keys inside `appendAuditLog(...)` at lint time as a regression guard. For multi-instance deployments, the same `AUDIT_HMAC_SECRET` must be shared across instances or `emailHash` will diverge between them.

Example patterns:
```jsonc
// Group membership change
{ "added": [{ "id": "u1", "name": "Max" }], "removed": [{ "id": "u2", "name": "Anna" }], "memberCount": 5 }
// Agent visibility change
{ "changes": { "visibility": { "from": "all", "to": "restricted" }, "allowedGroups": { "added": [{ "id": "g1", "name": "Engineering" }] } } }
// User invited with groups (email redacted)
{ "emailHash": "<hex64>", "emailPreview": "ma…ax@example.com", "role": "member", "groups": [{ "id": "g1", "name": "Engineering" }] }
// Telegram channel configured for agent
{ "agent": { "id": "a1", "name": "Support Bot" }, "channel": "telegram", "botUsername": "support_pinchy_bot" }
// Telegram channel removed from agent
{ "agent": { "id": "a1", "name": "Support Bot" }, "channel": "telegram" }
```

### Checklist for API Routes with State Changes
When creating or modifying any POST/PUT/PATCH/DELETE endpoint:
1. **Body validation via `parseRequestBody(schema, request)`** from `@/lib/api-validation`? Never call `await request.json()` directly — that throws 500 on malformed JSON, and ad-hoc `typeof` checks drift across routes. Define a Zod schema at the top of the route, then `const parsed = await parseRequestBody(schema, request); if ("error" in parsed) return parsed.error;`. Validation failures return `{ error: "Validation failed", details: <flatten> }` with status 400 — clients can read `details.fieldErrors.<name>` to render inline errors. Routes that take no body (e.g. DELETE on a path-param resource) are exempt.
2. `appendAuditLog()` or `deferAuditLog()` call present? If not needed: add `// audit-exempt: <reason>` comment
3. Pattern matches the action shape — `await appendAuditLog` for idempotent ops, `deferAuditLog` for non-rollbackable side effects? (See "Never fire-and-forget" above.)
4. Event type uses a valid `AuditResource` prefix (agent, group, user, settings, config, channel, chat) or one of the non-resource event families (`auth.*`, `tool.*`, `audit.exported`)?
5. Detail payload uses the correct base type (`UpdateDetail` for `*.updated`, `DeleteDetail` for `*.deleted`, `MembershipDetail` for `*.members_updated`)?
6. All referenced entities snapshotted as `{ id, name }` pairs (`EntityRef`)?
7. Test exists that verifies the `appendAuditLog` call with correct payload?
8. `outcome` field set correctly? `'success'` for the happy path (default), `'failure'` for error paths that still deserve an audit entry?
9. No plaintext email or other PII in `detail`? If you need to identify an email, use `redactEmail()` from `@/lib/audit`. If the resource already encodes the userId, log the display name only.

### Error & Notification Display Policy
User feedback (errors, success confirmations) must use the correct display pattern. Using the wrong one creates inconsistent UX.

**Inline errors** (`setError()` → `<p className="text-sm text-destructive">`) when:
- The error is directly tied to a form field (validation failure, invalid input)
- The user should correct their input and retry
- The form/dialog stays open after the error

**Toast notifications** (`toast.success()` / `toast.error()` from sonner) when:
- Confirming a completed action ("Settings saved", "Bot connected")
- A background or system error occurs that isn't tied to a specific field
- The UI navigates away after the action (dialog closes, redirect)

**Never mix both for the same action.** A form submission error is always inline, never a toast. A success confirmation is always a toast, never inline (exception: multi-step flows that show a success screen).

### Secrets Handling

Three secret-handling patterns, each with a specific scope. Pick the
right one based on **who reads the secret at runtime**.

#### Pattern A — OpenClaw built-in resolves (SecretRef)

For paths OpenClaw itself walks at runtime:
- `models.providers.<name>.apiKey` (LLM provider keys)
- `gateway.auth.token` (gateway auth — written as plaintext)
- `env.<VAR>` env-var templates resolved against process env

Use `secretRef(pointer)` from `packages/web/src/lib/openclaw-secrets.ts`,
add the value to the `SecretsBundle`, write the ref in `openclaw.json`.
Add a test asserting both halves.

#### Pattern B — Pinchy-aware plugins fetch via API (preferred for new credentials)

For credentials consumed by `packages/plugins/pinchy-*` plugins (Odoo,
web-search, email, future: Pipedrive, Salesforce, Stripe, etc.):

**Do NOT** put the credential — or even a SecretRef pointer — in the
plugin's config block in `openclaw.json`. OpenClaw 2026.4.x does not
walk arbitrary plugin config trees for SecretRef resolution; an
unresolved SecretRef object would reach the plugin verbatim and
typically blow up downstream (see #209: an Odoo dict reached the Python
server, which crashed with `unhashable type: 'dict'`).

Instead:
1. In `regenerateOpenClawConfig()`, write only `apiBaseUrl`,
   `gatewayToken`, and the integration's opaque `connectionId` into the
   plugin config (per-agent or top-level depending on the plugin).
2. The plugin fetches credentials lazily from
   `GET /api/internal/integrations/:connectionId/credentials` with the
   gateway token as Bearer auth — same call pattern as `pinchy-email`,
   `pinchy-odoo`, `pinchy-web`.
3. Cache in the plugin (5-min TTL recommended) plus invalidate-on-401
   for credential rotation.
4. Validate the returned credential shape at the plugin's edge with a
   clear `must be a string, got object` error if a regression sends
   an unresolved SecretRef.
5. Test at four layers:
   - Unit: openclaw-config writes the right shape (no credentials in
     plugin config; only connectionId + bootstrap creds).
   - Plugin unit: cache hit/miss, refetch on 401, shape validation
     rejects SecretRef payloads.
   - Plugin integration: against in-process mock-pinchy + the relevant
     mock service (e.g. mock-odoo). See
     `packages/plugins/pinchy-odoo/__tests__/integration.test.ts` for
     the canonical example.
   - Manual on staging.
6. **Manifest contract:** every Pinchy plugin's `openclaw.plugin.json#configSchema`
   must declare every field `regenerateOpenClawConfig()` writes (including
   top-level `apiBaseUrl`, `gatewayToken`, and any per-agent fields), and use
   `additionalProperties: false`. A contract test
   (`packages/plugins/<plugin>/config-schema.test.ts`) validates a representative
   emitted config against the manifest using Ajv. The build-time validator
   `validateBuiltConfig()` in `packages/web/src/lib/openclaw-config/validate-built-config.ts`
   enforces this at runtime — `regenerateOpenClawConfig()` refuses to write a config
   that doesn't match every plugin's manifest. When onboarding a new plugin, update:
   - `KNOWN_PINCHY_PLUGINS` in `plugin-manifest-loader.ts`
   - The plugin's `openclaw.plugin.json#configSchema`
   - A new `config-schema.test.ts` in the plugin directory

#### Pattern C — Bootstrap credentials (plaintext, single source)

`gateway.auth.token` and `plugins.entries.pinchy-*.config.gatewayToken`
are written as plaintext into `openclaw.json`. They are the *bootstrap*
credentials used to authenticate everything else. They cannot themselves
be fetched via Pinchy's API (chicken-and-egg). Treat them as the trust
root for the OpenClaw container; rotate by regenerating the config and
restarting OpenClaw.

#### Defense in depth

`packages/web/src/lib/openclaw-plaintext-scanner.ts` checks every
`openclaw.json` write for known provider-key prefixes (Anthropic
`sk-ant-…`, OpenAI `sk-…`, Gemini `AIza…`, etc.). Add a pattern there
when you onboard any new provider whose secret has a recognisable
prefix — even if you're following Pattern B.

`packages/web/src/lib/openclaw-config/validate-built-config.ts`
validates every emitted plugin entry against its manifest before
`regenerateOpenClawConfig()` writes the config. This catches manifest /
build.ts drift at startup so it can't surface as a silent `INVALID_CONFIG`
rejection at OpenClaw hot-reload time (see staging incident 2026-05-04 —
the pinchy-odoo staging block). Update the manifest, the `KNOWN_PINCHY_PLUGINS`
list in `plugin-manifest-loader.ts`, and the contract test together when
adding a new plugin.

### Documentation
- **Docs site**: `docs/` directory, built with Astro Starlight. Deployed to [docs.heypinchy.com](https://docs.heypinchy.com).
- **Docs-first process**: Every feature plan MUST include a documentation update task. When behavior changes, docs must be updated in the same PR.
- **Running docs locally**: `cd docs && pnpm install && pnpm dev` — opens at `http://localhost:4321`.
- **Docs are standalone**: The `docs/` directory is NOT part of the pnpm workspace. It has its own `package.json` and `pnpm-lock.yaml`.
- **Content structure**: Follows the [Diataxis framework](https://diataxis.fr/) — tutorials, how-to guides, explanation, and reference.

### Key Decisions
- **AGPL-3.0 License**: Prevents proprietary cloud forks without giving back
- **Build-in-public**: Progress shared via blog + LinkedIn
- **OpenClaw dependency**: Pinchy is NOT a fork — it's a layer on top. OpenClaw stays upstream.

## Origin Story

Pinchy was born when an AI agent accidentally sent its entire internal reasoning process as a WhatsApp message to a friend — instead of a simple "Sure, let's grab lunch!" That moment proved: AI agents without proper guardrails are a liability, not an asset.

## Who's Behind This

**Clemens Helm** — Software developer, 20+ years experience, daily OpenClaw power user. Building Pinchy to solve the problems he hit running AI agents in his own business (Helmcraft GmbH).

- Website: [heypinchy.com](https://heypinchy.com)
- LinkedIn: [clemenshelm](https://linkedin.com/in/clemenshelm)
- GitHub: [heypinchy/pinchy](https://github.com/heypinchy/pinchy)

## Related Resources

- **Pinchy Website**: [heypinchy.com](https://heypinchy.com) — Astro site, hosted on AWS S3 + CloudFront. Source: `/Users/clemenshelm/projects/heypinchy/`
- **Clemens' Website**: [clemenshelm.com](https://clemenshelm.com) — Pinchy project page with origin story. Source: `/Users/clemenshelm/Projects/avenir/clemenshelm-com/`
- **OpenClaw Docs**: [docs.openclaw.ai](https://docs.openclaw.ai) — essential reading for understanding the runtime
- **OpenClaw Discord**: Active community, Clemens is a member. Useful for upstream questions.
- **Pinchy Brand & Voice**: See [`PERSONALITY.md`](PERSONALITY.md) for the complete voice guide. English, "We" perspective, Basecamp-inspired tone. Lobster humor welcome. Read before writing any user-facing text.

## Competitor Landscape

Know these when making architectural decisions:

| Category | Players | Why Pinchy is different |
|----------|---------|----------------------|
| Cloud SaaS | Dust, Glean, StackAI | Data leaves company. Pinchy = self-hosted. |
| Workflow builders | n8n, Dify | Visual step chains, not autonomous agents. |
| Vendor lock-in | MS Copilot Studio, Google AgentSpace | Single-model, proprietary. Pinchy = model-agnostic. |
| Frameworks | CrewAI, LangChain, AutoGen | Libraries, not platforms. No UI/permissions/deploy. |
| OpenClaw | OpenClaw | Best runtime, but no enterprise governance layer. |

## Useful Commands

```bash
# Development (Docker — always use this, never run the app without Docker)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# With extra env vars (e.g. enterprise key)
PINCHY_ENTERPRISE_KEY=dev-enterprise docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# Production (Docker)
docker compose pull && docker compose up -d

# Common commands (run on host, not in container)
pnpm test                # Run test suite
pnpm build               # Production build
pnpm lint                # Run ESLint
pnpm format              # Format with Prettier
pnpm db:generate         # Generate migration from schema changes

# Documentation
cd docs && pnpm install && pnpm dev   # Docs dev server (port 4321)
cd docs && pnpm build                 # Build docs
```

> **Important:** Always use Docker Compose for development. The app requires PostgreSQL, OpenClaw, and automatic migrations — all handled by Docker Compose. Running `pnpm dev` directly will lead to missing migrations and broken infrastructure checks.

## Context for AI Assistants

When working on this project:
1. **The core is working** — setup, auth, provider config, agent chat, agent permissions (allow-list), knowledge base agents, user management (invites), personal/shared agents, audit trail, and Telegram channels are all implemented. Enterprise features (granular RBAC, plugin marketplace, additional channel integrations) are planned.
2. **OpenClaw is the foundation** — familiarize yourself with [OpenClaw docs](https://docs.openclaw.ai) before making architectural decisions
3. **Keep it simple** — prefer boring, proven technology over clever abstractions
4. **Test everything** — no PR without tests
5. **Think enterprise** — every feature must work for a team of 50, not just one developer
6. **Don't reinvent OpenClaw** — if OpenClaw already does it, use it. Pinchy wraps, extends, and governs — it doesn't replace.
7. **"Sell before you build"** — the website describes features as vision. Don't reference the website as documentation of existing functionality.
8. **AGPL matters** — any code suggestion must be compatible with AGPL-3.0. No proprietary dependencies.
9. **Pinchy's key differentiator is agent permissions/control** — not just multi-user, but granular agent permissions, RBAC, audit trail. This is the core value prop.
10. **Build in Public** — assume all code, decisions, and progress will be shared publicly. No secrets in commits.
11. **Docs-first** — every feature plan must include a documentation update task. Keep [docs.heypinchy.com](https://docs.heypinchy.com) in sync with the code.
