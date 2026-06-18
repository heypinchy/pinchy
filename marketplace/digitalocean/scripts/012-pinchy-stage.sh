#!/bin/bash
# Stage Pinchy for the pinned version (build-time): fetch the compose file and
# loading page, pre-pull the images, configure the firewall. Per-Droplet secrets
# are NOT written here — they are generated on first boot (001_onboot), so the
# shared snapshot never carries them.
set -euo pipefail

VERSION="${application_version:?application_version not set by Packer}"

mkdir -p /opt/pinchy /var/www/pinchy-loading

# Compose file + loading page for exactly this release
curl -fsSL "https://raw.githubusercontent.com/heypinchy/pinchy/${VERSION}/docker-compose.yml" \
  -o /opt/pinchy/docker-compose.yml
curl -fsSL "https://github.com/heypinchy/pinchy/releases/download/${VERSION}/installing.html" \
  -o /var/www/pinchy-loading/index.html

# Bake only the version pin. Secrets are per-Droplet (added on first boot).
echo "PINCHY_VERSION=${VERSION}" > /opt/pinchy/.env

# Pre-pull the three images so first boot is just "compose up".
(cd /opt/pinchy && docker compose pull)

# Firewall: SSH + HTTP/HTTPS only. img_check expects ufw active.
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

# The file provisioner does not preserve the executable bit.
chmod 755 /etc/update-motd.d/99-one-click
chmod 755 /var/lib/cloud/scripts/per-instance/001_onboot
