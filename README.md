<p align="center">
  <img src=".github/assets/pinchy-logo.png" alt="Pinchy" width="120" />
</p>

<h1 align="center">Pinchy</h1>

<p align="center">
  <strong>Self-hosted AI agent platform built on OpenClaw.</strong><br/>
  Enterprise-ready. Offline-capable. Open source. 🦞
</p>

<p align="center">
  <a href="https://docs.heypinchy.com">Docs</a> •
  <a href="https://heypinchy.com">Website</a> •
  <a href="https://heypinchy.com/blog">Blog</a> •
  <a href="https://github.com/heypinchy/pinchy/discussions">Discussions</a> •
  <a href="https://linkedin.com/in/clemenshelm">LinkedIn</a>
</p>

---

## What is Pinchy?

Pinchy is an enterprise layer on top of [OpenClaw](https://github.com/openclaw/openclaw) — the open-source AI agent framework. OpenClaw is incredibly powerful for individual power users. But for teams and companies, critical pieces are missing: permissions, audit trails, user management, and governance.

Pinchy fills that gap.

### The Problem

You want AI agents in your company. But:

- **Cloud platforms** (Dust, Glean, Copilot Studio) send your data to external servers. For regulated industries in the EU, that's a non-starter.
- **Workflow builders** (n8n, Dify) let you chain steps visually — but they're not autonomous agents.
- **Frameworks** (CrewAI, LangChain) are libraries, not platforms. No UI, no permissions, no deployment story.
- **OpenClaw** is the best open-source agent runtime — but it has no user management, no role-based access, no audit trail.

### The Solution

Pinchy wraps OpenClaw into something enterprises can trust:

- 🔌 **Plugin Architecture** — Agents get scoped tools, not raw shell access. A "Create Jira Ticket" plugin instead of `exec`.
- 🔐 **Role-Based Access Control** — Who can use which agent. What each agent can do. Per team, per role.
- 📋 **Audit Trail** — Every agent action logged. Who, what, when. Compliance-ready.
- 🔀 **Cross-Channel Workflows** — Input on email, output on Slack. Properly routed, properly permissioned.
- 🏠 **Self-Hosted & Offline** — Your server, your data, your models. Works without internet.
- 🤖 **Model Agnostic** — OpenAI, Anthropic, local models via Ollama. Your choice.

## Quick Start

```bash
git clone https://github.com/heypinchy/pinchy.git
cd pinchy
docker compose up --build
```

Then open [http://localhost:7777](http://localhost:7777) — the setup wizard will guide you through creating your admin account.

> **Production:** Copy `.env.example` to `.env` and set secure values for `DB_PASSWORD` and `NEXTAUTH_SECRET`. The defaults are for local evaluation only.

### Prerequisites

- Docker & Docker Compose
- An OpenClaw-compatible model provider (e.g. Claude Max subscription via OpenClaw OAuth)

## Status

> 🚧 **Pinchy is in early development.** The core is working — setup, auth, multi-user, agent chat, permissions, knowledge base agents, and audit trail. We're building the enterprise features (granular RBAC, plugin marketplace, cross-channel workflows) next.

### What works today

- **Setup wizard** — Create your admin account on first run
- **Authentication** — Credentials-based login with JWT sessions
- **Multi-user** — Invite users, admin and user roles, personal and shared agents
- **Agent chat** — Real-time WebSocket chat with OpenClaw agents, conversation history
- **Agent permissions** — Allow-list model for agent tools (safe and powerful categories)
- **Agent settings** — Configure name, model, system prompt, and tool permissions per agent
- **Knowledge Base agents** — Create agents with scoped read-only access to specific directories
- **Provider management** — Configure API keys for Anthropic, OpenAI, and Google
- **Docker Compose deployment** — Single command to run the full stack
- **Audit trail** — Cryptographic audit logging with HMAC-signed entries, integrity verification, and CSV export
- **CI pipeline** — Automated linting, testing, and security auditing

### What's coming

- Full RBAC with team-scoped permissions
- Plugin marketplace for agent tools
- Cross-channel workflows (email, Slack)
- Admin dashboard with usage analytics

Follow our progress on [the blog](https://heypinchy.com/blog/building-pinchy-in-public) and [LinkedIn](https://linkedin.com/in/clemenshelm).

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 16, React 19, TailwindCSS v4, shadcn/ui |
| Auth | Auth.js v5 (credentials provider) |
| Database | PostgreSQL 17, Drizzle ORM |
| Agent Runtime | OpenClaw Gateway (WebSocket) |
| Testing | Vitest, React Testing Library |
| CI/CD | GitHub Actions, ESLint, Prettier, Husky |
| Deployment | Docker Compose |

## Development

### Docker dev mode (recommended)

Run the full stack with hot reload — code changes are reflected immediately in the browser:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

After the initial build, subsequent starts only need:

```bash
docker compose -f docker-compose.yml -f docker-compose.dev.yml up
```

What hot-reloads: React components, pages, styles. What doesn't: `server.ts` (restart container), dependencies (rebuild with `--build`).

### Local development (without Docker for the app)

```bash
pnpm install

# Start database and OpenClaw in Docker (dev override exposes port 5433)
docker compose -f docker-compose.yml -f docker-compose.dev.yml up db openclaw -d

export DATABASE_URL=postgresql://pinchy:pinchy_dev@localhost:5433/pinchy
pnpm db:migrate
pnpm dev
```

The app starts at [http://localhost:7777](http://localhost:7777).

### Available commands

```bash
pnpm dev             # Start dev server
pnpm build           # Production build
pnpm test            # Run tests
pnpm lint            # Run ESLint
pnpm format          # Format code with Prettier
pnpm db:generate     # Generate migration from schema changes
pnpm db:migrate      # Apply pending migrations
pnpm db:studio       # Open Drizzle Studio (database browser)
```

### Project structure

```
pinchy/
├── packages/web/          # Next.js app
│   ├── src/
│   │   ├── app/           # Pages & API routes
│   │   ├── components/    # React components
│   │   ├── db/            # Schema & migrations
│   │   ├── lib/           # Utilities (auth, setup, agents)
│   │   ├── hooks/         # React hooks
│   │   └── server/        # WebSocket bridge
│   └── drizzle/           # Generated migrations
├── config/                # OpenClaw config
├── docs/                  # Documentation (Astro Starlight)
├── docker-compose.yml     # Full stack definition (production)
├── docker-compose.dev.yml # Dev override (hot reload, exposed DB port)
└── .github/workflows/     # CI + docs deployment
```

## Origin Story

Pinchy started when an AI agent sent a WhatsApp message it shouldn't have — leaking its entire internal reasoning process to a friend instead of a simple "Sure, let's grab lunch!" That moment made one thing clear: AI agents without proper guardrails are a liability, not an asset.

Read the full story on [heypinchy.com](https://heypinchy.com/blog/building-pinchy-in-public).

## Philosophy

We care about how Pinchy *feels*, not just what it does. Security + Ease is our core tension — enterprise-grade protection that feels light, not intimidating. Smart defaults everywhere, personality templates instead of blank slates, zero-config setup, and full customization when you need it.

Read more in our [Philosophy docs](https://docs.heypinchy.com/concepts/philosophy) and [`PERSONALITY.md`](PERSONALITY.md).

## Contributing

We love contributions! Whether it's code, docs, bug reports, or ideas — all are welcome.

Please read our [Contributing Guide](CONTRIBUTING.md) before submitting a PR. If you're writing any user-facing text, also check our [Personality Guide](PERSONALITY.md).

## Community

- 💬 [GitHub Discussions](https://github.com/heypinchy/pinchy/discussions) — Questions, ideas, show & tell
- 🐛 [Issues](https://github.com/heypinchy/pinchy/issues) — Bug reports and feature requests
- 📝 [Blog](https://heypinchy.com/blog) — Build in public updates
- 💼 [LinkedIn](https://linkedin.com/in/clemenshelm) — Daily updates from the founder

## License

Pinchy is licensed under the [GNU Affero General Public License v3.0](LICENSE) (AGPL-3.0).

This means you can use, modify, and distribute Pinchy freely — but if you run a modified version as a network service, you must release your changes under the same license. This protects the project from being turned into a proprietary cloud service without giving back.

## Who's Behind This

Pinchy is built by [Clemens Helm](https://clemenshelm.com) — a software developer with 20+ years of experience, daily OpenClaw power user, and believer in self-hosted AI.

Built in Vienna, Austria. ☕🦞
