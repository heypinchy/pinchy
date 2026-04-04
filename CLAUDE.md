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

- **Plugin Architecture** (partially implemented): Agents get scoped tools, not raw shell access. Two plugins implemented: `pinchy-files` (read-only file access for Knowledge Base agents) and `pinchy-context` (saves user/org context during Smithers onboarding interview). Plugin marketplace is planned.
- **Agent Permissions** (implemented): Allow-list model — agents start with zero tools, admins grant specific capabilities. Safe tools (list/read approved dirs) vs. powerful tools (shell, write, web).
- **RBAC** (partially implemented): Admin/user roles with agent access control (admins see all, users see shared + personal agents). Granular per-team/per-role RBAC is planned.
- **Audit Trail** (implemented): Every admin action logged — who, what, when. HMAC-SHA256 signed rows, integrity verification, CSV export. Compliance-ready.
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
│   └── plugins/
│       └── pinchy-files/  # Knowledge base file-access plugin for OpenClaw
├── config/                # OpenClaw config & startup script
├── sample-data/           # Sample docs for dev/testing (mounted at /data/)
├── docs/                  # Documentation (Astro Starlight, standalone)
├── docker-compose.yml     # Full stack definition (production)
├── docker-compose.dev.yml # Dev override (hot reload, exposed DB port)
├── Dockerfile.pinchy      # Production image
├── Dockerfile.pinchy.dev  # Dev image (no build step, runs pnpm dev)
├── Dockerfile.openclaw    # OpenClaw runtime image
├── .github/workflows/     # CI, docs deployment, SBOM generation
├── CLAUDE.md              # ← You are here
├── PERSONALITY.md         # Brand voice & tone guide (read before writing UI text)
├── CONTRIBUTING.md        # Contribution guidelines
├── SECURITY.md            # Security policy & vulnerability reporting
└── README.md              # Public-facing project description
```

## Development Guidelines

### Code Style
- TypeScript strict mode
- Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`
- One feature/fix per PR, small and focused
- **Test-Driven Development (TDD)**: Write the failing test first, then the implementation. No exceptions.
- Tests for all new features
- Update docs when behavior changes
- Update `packages/web/src/lib/smithers-soul.ts` when user-facing features change (Smithers must know the current platform)

### Architecture Principles
- **OpenClaw is the runtime** — don't reinvent what OpenClaw already does. Wrap it, extend it, govern it.
- **Plugin-first** — every integration should be a plugin, not hardcoded
- **Offline-first** — must work without internet (local models via Ollama)
- **API-first** — every UI action maps to a REST endpoint
- **Self-hosted** — no phone-home, no telemetry unless opt-in

### Audit Trail Guidelines
Every admin action that changes state MUST be logged via `appendAuditLog()`. The `detail` JSON field must follow these rules:

- **Snapshot human-readable names alongside IDs.** IDs alone are useless after an entity is deleted. Always include `{ id, name }` pairs for referenced entities (groups, users, agents).
- **Log what changed, not just that something changed.** Bad: `{ changes: ["visibility"] }`. Good: `{ changes: { visibility: { from: "all", to: "restricted" }, allowedGroups: { added: [{ id, name }], removed: [{ id, name }] } } }`.
- **Use added/removed diffs for membership changes.** Don't just log the final count — log who/what was added and removed with `{ id, name }` pairs.
- **Include the resource name in the detail** for delete events (the resource itself won't be queryable after deletion).
- **Keep detail under 2048 bytes** (larger payloads are auto-truncated with `_truncated: true`). For bulk operations with many items, summarize if needed.

Example patterns:
```jsonc
// Group membership change
{ "added": [{ "id": "u1", "name": "Max" }], "removed": [{ "id": "u2", "name": "Anna" }], "memberCount": 5 }
// Agent visibility change
{ "changes": { "visibility": { "from": "all", "to": "restricted" }, "allowedGroups": { "added": [{ "id": "g1", "name": "Engineering" }] } } }
// User invited with groups
{ "email": "max@example.com", "role": "member", "groups": [{ "id": "g1", "name": "Engineering" }] }
// Telegram channel configured for agent
{ "agent": { "id": "a1", "name": "Support Bot" }, "channel": "telegram", "botUsername": "support_pinchy_bot" }
// Telegram channel removed from agent
{ "agent": { "id": "a1", "name": "Support Bot" }, "channel": "telegram" }
```

### Checklist for API Routes with State Changes
When creating or modifying any POST/PUT/PATCH/DELETE endpoint:
1. `appendAuditLog()` call present? If not needed: add `// audit-exempt: <reason>` comment
2. Event type uses a valid `AuditResource` prefix (agent, group, user, settings, config)?
3. Detail payload uses the correct base type (`UpdateDetail` for `*.updated`, `DeleteDetail` for `*.deleted`, `MembershipDetail` for `*.members_updated`)?
4. All referenced entities snapshotted as `{ id, name }` pairs (`EntityRef`)?
5. Test exists that verifies the `appendAuditLog` call with correct payload?

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
