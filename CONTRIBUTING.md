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
4. **Keep commits atomic.** Each commit should represent one logical change and pass CI on its own. PRs are merged via rebase — the commit history lands verbatim on `main`, so individual commits must make sense in isolation.
5. **Add tests** for new features when applicable.
6. **Update docs** if your change affects user-facing behavior.
7. Submit your PR and fill out the template.

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

1. Add `127.0.0.1 local.heypinchy.com` to your `/etc/hosts` file
2. Start the stack as usual — Caddy is included automatically
3. Access Pinchy at `https://local.heypinchy.com:8443`
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
# Unit tests (fast, mocked, no Docker required)
pnpm test

# DB integration tests (real Postgres, slower — opts you into the DB-backed runner)
pnpm test:db
```

All new features require tests. We practice TDD — write the failing test first, then the implementation.

`pnpm test:db` provisions a `pinchy_test_vitest` database against the dev-stack Postgres on `localhost:5434`. Start it once with:

```bash
PINCHY_VERSION=dev docker compose -f docker-compose.yml -f docker-compose.dev.yml up -d db
```

To target a different Postgres, override `VITEST_INTEGRATION_DB_URL` (e.g. when running against a containerised PG 17 on port 5436, as CI does — see `.github/workflows/ci.yml`).

#### When to mock the database vs. use the real one

We're moving away from `vi.mock("@/db", ...)` in route-level tests (see [#229](https://github.com/heypinchy/pinchy/issues/229)). The rule of thumb:

| Test target                                                                      | Use the real DB?                                                  |
| -------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Pure functions, components, helpers with no DB calls                             | No — keep them in `*.test.ts` (the unit suite)                    |
| Route handlers, lib code whose primary job is to talk to the DB                  | Yes — write `*.integration.test.ts` against the real schema       |
| External network calls (OpenClaw gateway, Telegram, Anthropic, FS-heavy helpers) | Mock those at the module boundary even inside an integration test |

Convention: any file matching `**/*.integration.test.ts` runs in `pnpm test:db` and is excluded from `pnpm test`. Setup files live in [`packages/web/src/test-helpers/integration/`](packages/web/src/test-helpers/integration/).

## Code Style

- TypeScript strict mode
- Prettier for formatting, ESLint for linting
- Run `pnpm lint` and `pnpm format` before submitting
- Pre-commit hook runs linting automatically via Husky

## Schema migration policy

Pinchy's schema migrations are **forward-only**. Drizzle has no native rollback support and we don't fake it. Once a migration lands on `main`, the only way to undo it on a deployed instance is `pg_dump` restore + image rollback.

This shapes how we author destructive changes.

### Additive-only by default

In a normal release, schema changes are **additive**:

- New tables ✓
- New columns (NULL or with DEFAULT) ✓
- New indexes ✓ (note: Drizzle wraps migrations in transactions; `CREATE INDEX CONCURRENTLY` raises an error inside a transaction block — for large live tables, use a separate migration step outside a transaction block)
- New constraints `NOT VALID` (validate later) ✓

These don't break running app instances during a rolling deployment, and they don't hold ACCESS EXCLUSIVE locks for noticeable durations.

### Destructive DDL: Expand/Contract over two releases

Removing or transforming columns/tables requires the **Expand/Contract** pattern across **two consecutive releases** (minor or patch):

**Release N (Expand):**

- Add the new column/table
- Backfill data
- Update code to write to BOTH old and new
- Update code to read from new (with old as fallback)

**Release N+1 (Contract):**

- Remove old code paths
- Drop the old column/table

This means the app version running on a given DB always works with the schema at that point in time.

Column and table **renames are equally destructive** — any app version reading the old name breaks immediately. They are not currently blocked by Squawk. Treat renames the same way: add the new name, migrate all reads/writes, then drop the old name in a later release.

### CI enforcement

`.github/workflows/ci.yml` runs [Squawk](https://squawkhq.com/) on changed migration files in every PR. The following rules block merge:

- `ban-drop-column`
- `ban-drop-table`
- `changing-column-type` (`ALTER COLUMN ... TYPE`)

To override (only in a planned Contract release), add a Squawk-ignore comment directly above the offending statement:

```sql
-- squawk-ignore ban-drop-column
ALTER TABLE "agents" DROP COLUMN "old_field";
```

Adding the `squawk-ignore` comment is a deliberate act — Reviewers are expected to challenge it. Every override **must** be paired with a corresponding entry in `docs/src/content/docs/guides/upgrading.mdx` under `### Breaking changes` for that release. The `pnpm release` script enforces presence of that subsection — the release aborts if it's missing.

### Why no rollback automation?

[Drizzle does not support down-migrations](https://github.com/drizzle-team/drizzle-orm/discussions/1339), and writing reliable down-SQL by hand for every migration costs more than it saves. Our explicit stance: **rollback = restore from `pg_dump` + re-pin previous image tag.** This is also documented in the upgrading guide so admins aren't surprised.

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
{
  error && <p className="text-sm text-destructive">{error}</p>;
}
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

### Testing a release candidate

Before cutting a tag, the maintainer runs the pre-release build on a dedicated staging instance. Pushes to `main` automatically publish two tags:

- `ghcr.io/heypinchy/pinchy:next` — mutable, always HEAD of `main`
- `ghcr.io/heypinchy/pinchy:sha-<12-chars>` — immutable per commit

Same for `pinchy-openclaw`.

**One-time staging setup** on your staging host:

1. Deploy Pinchy normally, but pin `:next` in your `.env`:

   ```env
   PINCHY_VERSION=next
   ```

2. Install `/usr/local/bin/update-pinchy`:

   ```bash
   #!/usr/bin/env bash
   set -euo pipefail
   cd /srv/pinchy
   LOG=/var/log/pinchy-update.log
   echo "[$(date -Iseconds)] pulling" | tee -a "$LOG"
   docker compose pull 2>&1 | tee -a "$LOG"
   echo "[$(date -Iseconds)] restarting" | tee -a "$LOG"
   docker compose up -d 2>&1 | tee -a "$LOG"
   echo "[$(date -Iseconds)] waiting for health" | tee -a "$LOG"
   for i in $(seq 1 30); do
     curl -sf http://localhost:7777/api/health \
       && { echo "healthy" | tee -a "$LOG"; exit 0; }
     sleep 2
   done
   echo "health check failed" | tee -a "$LOG"
   docker compose ps | tee -a "$LOG"
   exit 1
   ```

   Make it executable: `chmod +x /usr/local/bin/update-pinchy`.

3. Schedule nightly updates via cron or systemd timer:
   ```cron
   0 4 * * *  root  /usr/local/bin/update-pinchy
   ```

**Before each release**, run `sudo update-pinchy` manually during business hours to pull the latest `:next` build, then click through the key flows on staging: Smithers chat, one live integration, one custom agent with chat history.

**Use synthetic data in staging.** Do not restore prod dumps — unnecessary privacy surface.

### Pre-release checklist

The release script and CI enforce image builds, GHCR visibility, end-user install, upgrade path, `pnpm audit`, and the presence of a correctly-structured upgrade-notes section. The items below are the remaining human judgment calls.

**Scope**

- [ ] All feature/fix PRs for this release are merged to `main`
- [ ] Dependencies reviewed (`pnpm outdated`) — no critical/security updates pending
- [ ] If upgrading OpenClaw: version bumped in `Dockerfile.openclaw`

**Model resolver** (only if models or templates changed)

- [ ] Spot-check Anthropic/OpenAI/Google changelogs for deprecated model IDs referenced in `src/lib/model-resolver/providers/`
- [ ] New Ollama family or new LLM provider added → resolver file + tests exist

**Documentation**

- [ ] `docs/src/content/docs/guides/upgrading.mdx` — new section drafted for this version (heading format: `## Upgrading from v<prev> to %%PINCHY_VERSION%%`) containing `### Breaking changes` (write "None." if there are none) and `### Upgrade notes` subsections. The release script enforces both subsections. The release workflow extracts this section automatically and prepends it to the GitHub Release body.

**Staging**

- [ ] Staging instance on `:next` was clicked through today: Smithers chat, one live integration, one custom agent. See [Staging instance setup](#staging-instance-setup) for the one-time setup and the refresh command (`docker compose pull && up -d`) you run before each click-through.

### Release steps

1. Complete the checklist above on `main`.
2. Run `pnpm release <new-version>` (e.g. `pnpm release 0.5.0`). The script verifies: clean working tree, on `main`, CI green, tag not taken, `upgrading.mdx` has the target-version section, `pnpm audit --audit-level=high --prod` passes, then bumps versions, commits, tags, and pushes.
3. GitHub Actions runs the release workflow: build + push images, verify GHCR visibility (anonymous pull test), run the end-user install smoke against published images, extract the upgrade notes from `upgrading.mdx`, create the GitHub Release (auto-generated notes with the upgrade-notes section prepended), deploy docs. Any failure means **the release is not installable for end-users — do not announce until fixed.**
4. Review the auto-generated GitHub Release notes. The "Upgrade notes" section at the top comes from `upgrading.mdx` — if it looks wrong, edit the release on GitHub directly.

### If the release workflow fails

**GHCR visibility gate (`end-user-install-published` job)**
A newly-added `ghcr.io/heypinchy/*` package defaulted to private. Fix:

1. Visit `https://github.com/heypinchy/pinchy/pkgs/container/<image-name>` → **Package settings** → **Change visibility** → **Public**.
2. Re-run the failed workflow job. Subsequent releases inherit the visibility automatically.

**End-user install published-image fail**
The published images + `docker-compose.yml` didn't start cleanly. Reproduce locally:

```bash
mkdir /tmp/pinchy-verify && cd /tmp/pinchy-verify
curl -o docker-compose.yml \
  https://raw.githubusercontent.com/heypinchy/pinchy/<tag>/docker-compose.yml
docker logout ghcr.io
docker compose pull
docker compose up -d
```

Fix the root cause and cut a patch release. Tags are immutable — never force-update.

**End-user upgrade fail (CI, before release)**
A Drizzle migration or config change breaks the upgrade from the previous tag. Reproduce with the CI job's steps locally. Fix before merging; this gate is meant to prevent broken upgrade paths from ever landing on `main`.

**`pnpm audit` fail (release script)**
A high or critical CVE was flagged in a production dependency. Fix the vulnerability (update the dep or switch to a patched version), or — if the finding is a false positive or acceptable risk — re-run with `--skip-audit` and document the acceptance in the release notes under a "Known issues" subsection.

## Staging instance setup

The pre-release click-through gate happens against a staging Hetzner instance that tracks the `:next` Docker images (rebuilt by `pre-release.yml` on every push to `main`). The setup mirrors the production Hetzner deploy with three differences: it pins `PINCHY_VERSION=next`, fetches `docker-compose.yml` from the `main` branch, and skips the bundled installer page (Caddy serves a short "starting" message during the ~30-second initial pull).

This is intentionally an internal/contributor workflow — the public docs at [docs.heypinchy.com](https://docs.heypinchy.com) cover production deploys only.

> **Caution.** Staging is reachable from the public internet by default. Never enter production API keys, real customer data, or production Telegram bot tokens. Treat staging as throwaway. Lock the instance down with Caddy basic auth, an IP allowlist, or a Hetzner cloud firewall before going further.

### One-time setup

1. **Create a Hetzner server** following the steps in the [Deploy on Hetzner Cloud](https://docs.heypinchy.com/guides/deploy-hetzner/) guide (4 GB RAM, EU location, SSH key) — but **paste [`staging/cloud-init.yml`](staging/cloud-init.yml) into the User Data field** instead of the production `cloud-init.yml`.
2. (Optional) Point a staging subdomain at the server IP, then SSH in and replace `:80` in `/etc/caddy/Caddyfile` with your domain. Run `systemctl reload caddy` — Let's Encrypt is automatic.
3. Open the Pinchy setup wizard, create a test admin, configure **test API keys only**.

### Refreshing staging to the latest `main`

Every push to `main` triggers the **Pre-release** workflow, which builds and publishes new `:next` images. Pull them onto your staging instance:

```bash
ssh root@<staging-ip> "cd /opt/pinchy && docker compose pull && docker compose up -d"
```

Run this manually before each pre-release click-through. Auto-deploy on every push to `main` is tracked in [issue #184](https://github.com/heypinchy/pinchy/issues/184) and lands in v0.6.0.

### Saving cost between releases

A CX22 staging instance costs about €5/month if it runs continuously. Between releases, you can **stop** the server in the Hetzner console — you only pay for storage (~€1/month) until you start it again. On restart, run the refresh command above to pick up any `:next` changes.

## Questions?

Open a [Discussion](https://github.com/heypinchy/pinchy/discussions). We're happy to help.
