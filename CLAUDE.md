# CLAUDE.md — Pinchy

## What is Pinchy?

Pinchy is an **enterprise AI agent platform** built on top of [OpenClaw](https://github.com/openclaw/openclaw). OpenClaw is the most powerful open-source AI agent runtime — but it's designed for individual power users. Pinchy adds the enterprise layer: permissions, audit trails, user management, and governance.

**Status: Early development.** The core is working — setup wizard, authentication, provider configuration, agent chat via OpenClaw, agent permissions (allow-list model), knowledge base agents, user management with invite system, personal and shared agents, audit trail, and Docker Compose deployment. Enterprise features (granular RBAC, plugin marketplace, cross-channel workflows) are next.

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
│  ┌────┴──────────────┴────────────┴───┐ │
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
│  🔀 Cross-Channel Workflows            │
│  🏠 Self-Hosted & Offline-Capable      │
│  🤖 Model Agnostic (OpenAI, Anthropic, │
│     Ollama, local models)              │
└─────────────────────────────────────────┘
```

### Core Concepts (planned and implemented)

- **Plugin Architecture** (partially implemented): Agents get scoped tools, not raw shell access. The `pinchy-files` plugin is the first working plugin (read-only file access for Knowledge Base agents). Plugin marketplace is planned.
- **Agent Permissions** (implemented): Allow-list model — agents start with zero tools, admins grant specific capabilities. Safe tools (list/read approved dirs) vs. powerful tools (shell, write, web).
- **RBAC** (partially implemented): Admin/user roles with agent access control (admins see all, users see shared + personal agents). Granular per-team/per-role RBAC is planned.
- **Audit Trail** (implemented): Every admin action logged — who, what, when. HMAC-SHA256 signed rows, integrity verification, CSV export. Compliance-ready.
- **User Management** (implemented): Invite system with token-based onboarding, admin and user roles, password management.
- **Knowledge Base Agents** (implemented): Scoped read-only access to specific directories. Template-based creation.
- **Cross-Channel Workflows**: Input on email, output on Slack. Properly routed and permissioned. (Planned)
- **Self-Hosted**: Your server, your data, your models. Works without internet.
- **Docker Compose Deployment**: Single `docker compose up` to run everything.

## Tech Stack

- **Frontend**: Next.js 16, React 19, Tailwind CSS v4, shadcn/ui, assistant-ui
- **State Management**: zustand
- **Auth**: Auth.js v5 (credentials provider, JWT sessions)
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
# Production (Docker)
docker compose up --build

# Docker dev mode (hot reload)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build

# Local development (without Docker for the app)
pnpm install
docker compose -f docker-compose.yml -f docker-compose.dev.yml up db openclaw -d
export DATABASE_URL=postgresql://pinchy:pinchy_dev@localhost:5433/pinchy
pnpm db:migrate
pnpm dev                 # Start dev server (port 7777)

# Common commands
pnpm test                # Run test suite
pnpm build               # Production build
pnpm lint                # Run ESLint
pnpm format              # Format with Prettier
pnpm db:generate         # Generate migration from schema changes
pnpm db:migrate          # Apply pending migrations

# Documentation
cd docs && pnpm install && pnpm dev   # Docs dev server (port 4321)
cd docs && pnpm build                 # Build docs
```

## Context for AI Assistants

When working on this project:
1. **The core is working** — setup, auth, provider config, agent chat, agent permissions (allow-list), knowledge base agents, user management (invites), personal/shared agents, and audit trail are all implemented. Enterprise features (granular RBAC, plugin marketplace, cross-channel workflows) are planned.
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
