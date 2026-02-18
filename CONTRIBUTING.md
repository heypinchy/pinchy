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

### Improving Documentation

Docs PRs are always welcome — typo fixes, better examples, translations. No change is too small.

## Development Setup

```bash
# Clone the repo
git clone https://github.com/heypinchy/pinchy.git
cd pinchy

# Install dependencies
npm install

# Run in development mode
npm run dev
```

> ⚠️ Detailed setup instructions will be added as the codebase matures.

## Code Style

- TypeScript preferred
- Prettier for formatting
- ESLint for linting
- Run `npm run lint` before submitting

## Code of Conduct

By participating in this project, you agree to our [Code of Conduct](CODE_OF_CONDUCT.md). Be kind, be respectful, assume good intentions.

## Questions?

Open a [Discussion](https://github.com/heypinchy/pinchy/discussions). We're happy to help.
