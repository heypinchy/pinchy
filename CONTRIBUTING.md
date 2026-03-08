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

## Code of Conduct

By participating in this project, you agree to our [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, be respectful, assume good intentions.

## Releasing

Pinchy uses [Semantic Versioning](https://semver.org/) and tags on `main`.

1. Ensure all changes are merged to `main` and CI is green.
2. Update `docs/src/content/docs/installation.mdx` with the new version (checkout tag + version note).
3. If upgrading OpenClaw, update the version in `Dockerfile.openclaw`.
4. Merge the release preparation PR.
5. Tag and push:
   ```bash
   git tag v0.2.0
   git push origin v0.2.0
   ```
6. The release workflow automatically creates a GitHub Release with auto-generated release notes and deploys the docs.

## Questions?

Open a [Discussion](https://github.com/heypinchy/pinchy/discussions). We're happy to help.
