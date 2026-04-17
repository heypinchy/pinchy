# Contributing to Pinchy

First off — thank you! Every contribution matters, whether it's code, docs, bug reports, or ideas. 🦞

## How to Contribute

### Reporting Bugs

1. Check [existing issues](https://github.com/heypinchy/pinchy/issues) first — someone might have reported it already.
2. Use the **Bug Report** issue template.
3. Include: what you expected, what happened, steps to reproduce, and your environment (OS, Node version, etc.).

### Suggesting Features

1. Open a [Discussion](https://github.com/heypinchy/pinchy/discussions) first to gauge interest.
2. If there's consensus, create a **Feature Request** issue.
3. Describe the use case, not just the solution. "I need X because Y" is more helpful than "Add X."

### Submitting Code

1. **Fork** the repo and create a branch from `main`.
2. **Keep PRs small and focused.** One feature or fix per PR.
3. **Write meaningful commit messages.** We follow [Conventional Commits](https://www.conventionalcommits.org/):
   - `feat: add plugin permission layer`
   - `fix: resolve cross-channel routing issue`
   - `docs: update getting started guide`
4. **Add tests** for new features when applicable.
5. **Update docs** if your change affects user-facing behavior.
6. Submit your PR and fill out the template.

### Voice & Personality

Pinchy has a personality. Before writing any user-facing text — UI labels, tooltips, error messages, empty states, docs — read [`PERSONALITY.md`](PERSONALITY.md). It defines how Pinchy sounds and why.

### Improving Documentation

Docs PRs are always welcome — typo fixes, better examples, translations. No change is too small.

## Development Setup

### Docker dev mode (recommended)

The easiest way to get started. Runs the full stack with hot reload:

```bash
git clone https://github.com/heypinchy/pinchy.git
cd pinchy
docker compose -f docker-compose.yml -f docker-compose.dev.yml up --build
```

Open [http://localhost:7777](http://localhost:7777). Code changes in `packages/web/` are reflected immediately in the browser.

### HTTPS Testing (Optional)

To test HTTPS-related features locally:

1. Add `127.0.0.1 pinchy.local` to your `/etc/hosts` file
2. Start the stack as usual — Caddy is included automatically
3. Access Pinchy at `https://pinchy.local:8443`
4. Your browser will warn about the self-signed certificate — accept it once

Regular development at `http://localhost:7777` continues to work unchanged.

### Local development (without Docker for the app)

```bash
git clone https://github.com/heypinchy/pinchy.git
cd pinchy
pnpm install

# Start database and OpenClaw in Docker
docker compose -f docker-compose.yml -f docker-compose.dev.yml up db openclaw -d

export DATABASE_URL=postgresql://pinchy:pinchy_dev@localhost:5433/pinchy
pnpm db:migrate
pnpm dev
```

### Running tests

```bash
pnpm test
```

All new features require tests. We practice TDD — write the failing test first, then the implementation.

## Code Style

- TypeScript strict mode
- Prettier for formatting, ESLint for linting
- Run `pnpm lint` and `pnpm format` before submitting
- Pre-commit hook runs linting automatically via Husky

## UI Conventions

### Error Messages & Notifications

We use two patterns for user feedback — **inline errors** and **toast notifications**. Using the right one matters for consistency.

**Inline errors** (rendered below the input field):
- Form validation failures — wrong password, invalid token, expired code
- The user needs to correct something and retry
- The form stays open

```tsx
const [error, setError] = useState("");
// In the handler:
setError("Invalid or expired pairing code");
// In JSX:
{error && <p className="text-sm text-destructive">{error}</p>}
```

**Toast notifications** (via [sonner](https://sonner.emilkowal.dev/)):
- Success confirmations — "Settings saved", "Bot connected"
- System errors not tied to a form field
- Actions where the UI navigates away afterward

```tsx
toast.success("Telegram bot connected");
toast.error("Failed to disconnect");
```

**Rule of thumb:** If there's an input field the user should fix → inline. Everything else → toast. Never use both for the same action.

## Code of Conduct

By participating in this project, you agree to our [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, be respectful, assume good intentions.

## Releasing

Pinchy uses [Semantic Versioning](https://semver.org/) and tags on `main`.

### Pre-release checklist

Before running the release script, complete these manual steps:

**Code & dependencies**
- [ ] All feature/fix PRs for this release are merged to `main`
- [ ] CI is green on `main` (the release script verifies this automatically)
- [ ] Dependencies up to date (`pnpm outdated` — no critical/security updates pending)
- [ ] If upgrading OpenClaw: version updated in `Dockerfile.openclaw`

**Model resolver**
- [ ] Every non-`custom` template in `AGENT_TEMPLATES` has a `modelHint` with a valid `tier` — run `pnpm test src/lib/__tests__/agent-templates.test.ts` and confirm green
- [ ] Model IDs in `src/lib/model-resolver/providers/` still match live provider offerings — spot-check Anthropic/OpenAI/Google changelogs for deprecated model IDs
- [ ] If new Ollama families gained popularity since last release, update `src/lib/model-resolver/families.ts` and `ollama-cloud.ts`
- [ ] If a new LLM provider was added, a resolver file exists under `src/lib/model-resolver/providers/<provider>.ts` with tests

**Documentation**
- [ ] `docs/src/content/docs/guides/upgrading.mdx` — add a section for the new version (breaking changes, new env vars, migration notes)
- [ ] `packages/web/src/lib/smithers-soul.ts` — update if user-facing features changed

Everything else (version bumps in `package.json`, commit, tag, push) is handled automatically by the release script.

### Release steps

1. Complete the manual checklist above on `main`.
2. Run the release script:
   ```bash
   pnpm release 0.3.0
   ```
   The script checks: clean working tree, on `main`, CI green, tag not already taken — then bumps versions, commits, tags, and pushes.
3. GitHub Actions creates the GitHub Release with auto-generated notes and deploys the docs automatically.
4. Review the auto-generated release notes on GitHub — edit if needed to highlight breaking changes or upgrade steps.

### First-time-only: publish container images

GHCR creates packages as **private** on first push. If you ever add a new image name to `release.yml` (today we publish `pinchy` and `pinchy-openclaw`), do this **once** right after the first release that pushes it, otherwise `docker compose pull` on users' servers will fail with `unauthorized`:

1. If the org's package-visibility policy disallows public packages, open [Org Settings → Packages](https://github.com/organizations/heypinchy/settings/packages) and allow "Public" under "Container image visibility."
2. Visit the new package page at `https://github.com/heypinchy/pinchy/pkgs/container/<image-name>`, click **Package settings**, and under "Danger Zone" → **Change visibility** set it to **Public**.

Once public, subsequent tag pushes (every release) inherit the visibility — no recurring step.

## Questions?

Open a [Discussion](https://github.com/heypinchy/pinchy/discussions). We're happy to help.
