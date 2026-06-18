# Pinchy on the DigitalOcean Marketplace

A [Packer](https://www.packer.io/) build that produces a DigitalOcean snapshot
image which runs Pinchy's **real production `docker-compose.yml`** — the same
three-service stack (pinchy + openclaw + postgres), the same tmpfs secrets
volume, the same healthcheck ordering. Nothing about Pinchy's security model is
adapted away; the Droplet just runs the stack we already ship and test.

The pinned version lives in `template.json` (`variables.application_version`)
and is kept in lockstep with `.env.example` by `pnpm release` and the
`scripts/lib/marketplace-version.test.mjs` drift guard.

## What the build does

**At build time** (baked into the snapshot, so first boot is fast):

- Installs Docker + Compose, Caddy (reverse proxy + loading page), ufw.
- Fetches `docker-compose.yml` and the loading page for the pinned release.
- Pre-pulls the three container images.
- Bakes only `PINCHY_VERSION` into `/opt/pinchy/.env` — **no secrets**.
- Runs DigitalOcean's cleanup requirements so the image passes `img_check.sh`.

**On first boot of each customer Droplet** (`per-instance/001_onboot`):

- Generates per-Droplet `DB_PASSWORD`, `BETTER_AUTH_SECRET`, `ENCRYPTION_KEY`.
- Creates a 2 GB swap file.
- Brings Pinchy up (`docker compose up -d`).

Per-Droplet secrets are never baked into the shared snapshot.

## Prerequisites (founder-gated)

1. A DigitalOcean account, and Marketplace **vendor** access — apply at
   <https://marketplace.digitalocean.com/vendors>. This gates the Vendor Portal
   where the listing is submitted and reviewed.
2. [`packer`](https://developer.hashicorp.com/packer/install) installed.
3. A DigitalOcean API token with **write** scope, exported as
   `DIGITALOCEAN_TOKEN`.

## Build the snapshot

```bash
cd marketplace/digitalocean
packer init .                      # installs the digitalocean plugin (first run)
DIGITALOCEAN_TOKEN=dop_v1_… packer build template.json
```

Packer spins up a temporary $6 build Droplet, provisions it, snapshots it into
your DigitalOcean account, and destroys the Droplet. DigitalOcean strongly
recommends the `s-1vcpu-1gb` ($6) build size so the image stays compatible with
all Droplet plans (already set in `template.json`).

## Validate before submitting

Run DigitalOcean's official image validation against a Droplet booted from the
snapshot (DigitalOcean runs the same check on submission):

```bash
# On a Droplet created from the snapshot, as root:
curl -sSL https://raw.githubusercontent.com/digitalocean/marketplace-partners/master/scripts/99-img-check.sh | bash
```

It must report **no FAIL** lines (ufw active, cloud-init present, no pending
security updates, no leftover keys/history/agent). Then smoke-test the app:
visit `http://<droplet-ip>` and confirm the Pinchy setup wizard loads.

## Submit

In the [Vendor Portal](https://cloud.digitalocean.com/vendorportal), create the
1-Click app listing, point it at the snapshot, fill in the listing copy, and
submit for review. DigitalOcean reviews the initial listing manually (no
published SLA).

## Updating for a new release

`pnpm release X.Y.Z` bumps `template.json` to the new version automatically. To
publish the update:

1. Rebuild the snapshot (`packer build template.json`) on the new version.
2. `PATCH` the listing to the new snapshot via the Vendor API:

   ```bash
   curl -X PATCH \
     -H "Authorization: Bearer $DIGITALOCEAN_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{ "reasonForUpdate": "Pinchy X.Y.Z", "imageId": <snapshot-id>,
           "softwareIncluded": [{ "name": "Pinchy", "version": "X.Y.Z" }] }' \
     https://api.digitalocean.com/api/v1/vendor-portal/apps/<app-id>
   ```

   Note: a PATCH returns the app to `pending`, so version updates re-enter
   DigitalOcean's review queue. The pinned version only sets the **starting**
   version for new installs — existing Droplets update themselves by bumping
   `PINCHY_VERSION` in `/opt/pinchy/.env`, independent of the listing.

## License

Pinchy is AGPL-3.0. DigitalOcean's
[Marketplace Vendor Terms](https://www.digitalocean.com/legal/marketplace-vendor-terms)
grant DigitalOcean only a license to display the **listing**, with no
sublicensing or managed-SaaS grant over the software — compatible with AGPL, the
same basis on which Nextcloud and Mastodon (also AGPL) ship as 1-Click apps.
