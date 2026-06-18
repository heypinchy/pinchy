#!/bin/bash
# Install Caddy (reverse proxy) from its official Cloudsmith apt repository.
# The Caddyfile is pre-staged at /etc/caddy/Caddyfile by the file provisioner,
# so --force-confold keeps our config instead of dpkg's default on install.
set -euo pipefail

export DEBIAN_FRONTEND=noninteractive

curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
  | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
  | tee /etc/apt/sources.list.d/caddy-stable.list
apt-get -qqy update
apt-get -qqy -o Dpkg::Options::=--force-confold install caddy
systemctl enable caddy
