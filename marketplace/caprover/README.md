# Pinchy on CapRover

A [CapRover](https://caprover.com) One-Click App template (`captainVersion: 4`)
that deploys Pinchy's three-service stack (pinchy + openclaw + postgres) onto a
CapRover server. The web UI (port 7777) is exposed through CapRover's reverse
proxy; OpenClaw and PostgreSQL stay on the internal Swarm network.

The pinned version lives in `pinchy.yml` (the `$$cap_pinchy_version` variable)
and is kept in lockstep with `.env.example` by `pnpm release` and the
`scripts/lib/marketplace-version.test.mjs` drift guard.

## Two deviations CapRover forces (and how we handle them)

CapRover's one-click schema can't express two things Pinchy's production compose
relies on. Both are documented here so the security trade-off is explicit, not
silent.

1. **`openclaw-secrets` can't be a tmpfs.** In production it's a RAM-only volume
   (cleared on restart, rebuilt from the encrypted database). CapRover only
   supports regular named volumes, so here it's a shared on-disk volume
   (`$$cap_appname-oc-secrets`). The bounded impact: a runtime SecretRef *cache*
   lands on the host disk instead of RAM. It is **not** the source of truth —
   the actual provider keys stay AES-256-GCM-encrypted in PostgreSQL and the
   cache is rebuilt from them. For deployments where runtime secrets must never
   touch disk, use the DigitalOcean image or the raw docker-compose, which keep
   the real tmpfs.

2. **CapRover ignores `depends_on`/healthcheck ordering.** Production gates
   start order (db healthy -> pinchy -> openclaw). CapRover starts services
   independently, so first boot relies on `restart: unless-stopped` to converge:
   pinchy/openclaw restart until the database (and each other) are reachable.
   First boot is therefore a little noisier, but self-heals. **This is the main
   thing to confirm on the test deploy below.**

`extra_hosts` (the `ollama.local` host-gateway mapping for a local Ollama) is
also unsupported by CapRover's parser and is omitted — use a cloud model
provider or run Ollama as its own CapRover app.

## Test before submitting (needs your own CapRover server)

CapRover is self-hosted, so there's no sandbox — you need a server running
CapRover:

1. Provision a small x86 VPS (>= 2 GB RAM; Pinchy + OpenClaw + Postgres want
   headroom) and [install CapRover](https://caprover.com/docs/get-started.html)
   (opens ports 80/443/3000 and wants a wildcard DNS record for HTTPS).
2. In the CapRover dashboard: **Apps -> One-Click Apps/Databases ->
   `>> TEMPLATE <<`**, paste the contents of `pinchy.yml`, and deploy.
3. Verify:
   - all three services come up (allow a couple of restart cycles — see
     deviation 2),
   - the web app reaches the setup wizard at its URL (enable HTTPS first),
   - the three shared volumes work (pinchy and openclaw both read/write
     `oc-config`, `oc-secrets`, `workspaces`, `oc-extensions`),
   - a chat round-trip works end to end.

## Submit

Open a PR against [`caprover/one-click-apps`](https://github.com/caprover/one-click-apps):

- `public/v4/apps/pinchy.yml` — this template.
- `public/v4/logos/pinchy.png` — the Pinchy logo
  (`packages/web/public/icon-512.png` in this repo).

Keep `isOfficial: false` (Pinchy is a third-party image). A CapRover maintainer
reviews and merges; there's no automatic publish.

## Updating for a new release

`pnpm release X.Y.Z` bumps `$$cap_pinchy_version` in `pinchy.yml` automatically.
Open a follow-up PR to `caprover/one-click-apps` with the new template. The
pinned version only sets the **starting** version for new installs; existing
deployments update by changing the version variable and redeploying.

## License

Pinchy is AGPL-3.0. The app runs entirely on the user's own CapRover server —
CapRover gets no license grant over the software — so listing it is plain FOSS
distribution, compatible with AGPL.
