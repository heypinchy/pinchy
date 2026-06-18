#!/bin/bash
# DigitalOcean Marketplace image cleanup — runs last, before the snapshot.
# Requirements distilled from digitalocean/marketplace-partners img_check.sh:
# no pending security updates, no leftover secrets/keys/history, no DO agent,
# and cloud-init instance state wiped so per-instance scripts re-run on the
# customer's Droplet. Best-effort throughout (no set -e).
set -uo pipefail

export DEBIAN_FRONTEND=noninteractive

# img_check needs a writable /tmp for its own update check
mkdir -p /tmp && chmod 1777 /tmp

# Install all pending updates — img_check FAILs on any pending security update
apt-get -qqy update
apt-get -qqy -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold upgrade
apt-get -qqy autoremove
apt-get -qqy autoclean
apt-get -qqy clean

# Remove the DigitalOcean monitoring agent — img_check FAILs if present
apt-get -qqy purge 'droplet-agent*' 2>/dev/null || true

# Clear logs
find /var/log -mtime -1 -type f -exec truncate -s 0 {} \; 2>/dev/null || true
rm -rf /var/log/*.gz /var/log/*.[0-9] /var/log/*-???????? 2>/dev/null || true
[ -f /var/log/wtmp ] && truncate -s 0 /var/log/wtmp
[ -f /var/log/lastlog ] && truncate -s 0 /var/log/lastlog

# Remove SSH host keys + any authorized_keys (regenerated on first boot)
rm -f /etc/ssh/*key*
rm -f /root/.ssh/authorized_keys
touch /etc/ssh/revoked_keys && chmod 600 /etc/ssh/revoked_keys

# Wipe cloud-init instance state so per-instance/001_onboot re-runs on first boot
rm -rf /var/lib/cloud/instances/*
cloud-init clean --logs 2>/dev/null || true

# Clear shell history
unset HISTFILE
rm -f /root/.bash_history
find /home -name '.bash_history' -exec rm -f {} \; 2>/dev/null || true

# Clear temp dirs
rm -rf /tmp/* /var/tmp/*

# Zero free space so the snapshot compresses well (best-effort)
dd if=/dev/zero of=/zerofile bs=1M 2>/dev/null || true
rm -f /zerofile
sync
